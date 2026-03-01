import { db } from "@/db";
import { fileLocks, sessions } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

export type LockConflict = {
  filePath: string;
  sessionId: string;
};

export type AcquireLockResult =
  | {
      ok: true;
      lockedFiles: string[];
    }
  | {
      ok: false;
      reason: "conflict";
      conflicts: LockConflict[];
    };

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const withCode = error as { code?: string; cause?: { code?: string } };
  return withCode.code === "23505" || withCode.cause?.code === "23505";
}

export class LockManager {
  static async acquireLocks(sessionId: string, filePaths: string[]): Promise<AcquireLockResult> {
    const uniquePaths = [...new Set(filePaths)];
    if (uniquePaths.length === 0) {
      return { ok: true, lockedFiles: [] };
    }

    return await db.transaction(async (tx) => {
      const existingLocks = await tx
        .select({
          filePath: fileLocks.filePath,
          sessionId: fileLocks.sessionId,
        })
        .from(fileLocks)
        .where(inArray(fileLocks.filePath, uniquePaths));

      const conflicts = existingLocks.filter((lock) => lock.sessionId !== sessionId);
      if (conflicts.length > 0) {
        return {
          ok: false,
          reason: "conflict" as const,
          conflicts,
        };
      }

      const alreadyLockedBySession = new Set(existingLocks.map((lock) => lock.filePath));
      const newLocks = uniquePaths
        .filter((filePath) => !alreadyLockedBySession.has(filePath))
        .map((filePath) => ({
          sessionId,
          filePath,
        }));

      if (newLocks.length === 0) {
        return {
          ok: true,
          lockedFiles: uniquePaths,
        };
      }

      try {
        await tx.insert(fileLocks).values(newLocks);
        return {
          ok: true,
          lockedFiles: uniquePaths,
        };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }

        const contestedLocks = await tx
          .select({
            filePath: fileLocks.filePath,
            sessionId: fileLocks.sessionId,
          })
          .from(fileLocks)
          .where(inArray(fileLocks.filePath, uniquePaths));

        return {
          ok: false,
          reason: "conflict" as const,
          conflicts: contestedLocks.filter((lock) => lock.sessionId !== sessionId),
        };
      }
    });
  }

  /**
   * Checks if any of the requested files are already locked by another session.
   * If not, it creates new locks for the given session.
   * 
   * @param sessionId The Jules Session ID requesting the locks
   * @param filePaths List of absolute paths to be locked
   * @returns boolean true if locks were successfully acquired, false otherwise
   */
  static async requestLock(sessionId: string, filePaths: string[]): Promise<boolean> {
    const result = await LockManager.acquireLocks(sessionId, filePaths);
    return result.ok;
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
   * Transfers all locks from an old session to a new session.
   * Useful for handing off context during self-healing / remediation.
   */
  static async transferLocks(oldSessionId: string, newSessionId: string, dbOrTx: any = db): Promise<void> {
    await dbOrTx
      .update(fileLocks)
      .set({ sessionId: newSessionId })
      .where(eq(fileLocks.sessionId, oldSessionId));
  }

  /**
   * Releases all locks held by a session.
   * (Utility function not explicitly in spec but necessary for cleanup/tests)
   */
  static async releaseLocks(sessionId: string) {
    await db.delete(fileLocks).where(eq(fileLocks.sessionId, sessionId));
  }
}
