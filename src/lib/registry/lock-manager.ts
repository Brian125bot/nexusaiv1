import { db } from "@/db";
import { fileLocks, sessions } from "@/db/schema";
import { eq, inArray, and } from "drizzle-orm";

export class LockManager {
  /**
   * Checks if any of the requested files are already locked by another session.
   * If not, it creates new locks for the given session.
   * 
   * @param sessionId The Jules Session ID requesting the locks
   * @param filePaths List of absolute paths to be locked
   * @returns boolean true if locks were successfully acquired, false otherwise
   */
  static async requestLock(sessionId: string, filePaths: string[]): Promise<boolean> {
    if (filePaths.length === 0) return true;

    return await db.transaction(async (tx) => {
      // Check if any of these files are already locked
      const existingLocks = await tx
        .select()
        .from(fileLocks)
        .where(inArray(fileLocks.filePath, filePaths));

      if (existingLocks.length > 0) {
        // Some files are already locked.
        // If they are locked by the SAME session, we might want to allow it?
        // But the spec says "reject a second lock request for the same path"
        // Let's check if they belong to another session.
        const lockedByOthers = existingLocks.filter(lock => lock.sessionId !== sessionId);
        if (lockedByOthers.length > 0) {
          return false;
        }
        
        // If all existing locks are by the same session, we can skip re-locking them?
        // Or just re-insert others.
        const alreadyLockedByMe = new Set(existingLocks.map(l => l.filePath));
        const newFilesToLock = filePaths.filter(path => !alreadyLockedByMe.has(path));
        
        if (newFilesToLock.length > 0) {
          await tx.insert(fileLocks).values(
            newFilesToLock.map(path => ({
              sessionId,
              filePath: path,
            }))
          );
        }
        return true;
      }

      // No existing locks, so we can proceed.
      await tx.insert(fileLocks).values(
        filePaths.map(path => ({
          sessionId,
          filePath: path,
        }))
      );

      return true;
    });
  }

  /**
   * Returns a list of active sessions that are currently "touching" those files.
   * 
   * @param filePaths List of paths to check for conflicts
   * @returns Array of objects containing session info and the file path they locked
   */
  static async getConflictStatus(filePaths: string[]) {
    if (filePaths.length === 0) return [];

    const conflicts = await db
      .select({
        sessionId: fileLocks.sessionId,
        filePath: fileLocks.filePath,
        lockedAt: fileLocks.lockedAt,
        sessionStatus: sessions.status,
        branchName: sessions.branchName,
      })
      .from(fileLocks)
      .innerJoin(sessions, eq(fileLocks.sessionId, sessions.id))
      .where(inArray(fileLocks.filePath, filePaths));

    return conflicts;
  }

  /**
   * Releases all locks held by a session.
   * (Utility function not explicitly in spec but necessary for cleanup/tests)
   */
  static async releaseLocks(sessionId: string) {
    await db.delete(fileLocks).where(eq(fileLocks.sessionId, sessionId));
  }
}
