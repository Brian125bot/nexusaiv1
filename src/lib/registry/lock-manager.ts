import { db } from "@/db";
import { fileLocks, sessions } from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";

export type LockConflict = {
  filePath: string;
  sessionId: string;
  type: "shared" | "exclusive";
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
  static async acquireLocks(
    sessionId: string,
    intents: Array<{ filePath: string; type: "shared" | "exclusive" }>
  ): Promise<AcquireLockResult> {
    const uniqueIntentsMap = new Map<string, "shared" | "exclusive">();
    for (const intent of intents) {
      // If same path is requested multiple times with different intent, elevate to exclusive
      const existing = uniqueIntentsMap.get(intent.filePath);
      if (existing === "exclusive" || intent.type === "exclusive") {
        uniqueIntentsMap.set(intent.filePath, "exclusive");
      } else {
        uniqueIntentsMap.set(intent.filePath, "shared");
      }
    }

    const uniquePaths = Array.from(uniqueIntentsMap.keys());
    if (uniquePaths.length === 0) {
      return { ok: true, lockedFiles: [] };
    }

    return await db.transaction(async (tx) => {
      // Using FOR UPDATE to serialize access to the locked files
      const existingLocks = await tx.execute(sql`
        SELECT session_id as "sessionId", file_path as "filePath", type
        FROM file_locks
        WHERE file_path IN ${uniquePaths}
        FOR UPDATE
      `);

      const conflicts: LockConflict[] = [];
      for (const row of existingLocks.rows as Record<string, unknown>[]) {
        const requestedType = uniqueIntentsMap.get(row.filePath as string);
        if (row.sessionId !== sessionId) {
          // Rule 1: Requesting shared, existing is exclusive -> Conflict
          // Rule 2: Requesting shared, existing is shared -> Grant (No conflict added)
          // Rule 3: Requesting exclusive, existing is any -> Conflict
          if (requestedType === "exclusive" || row.type === "exclusive") {
            conflicts.push({
              filePath: row.filePath as string,
              sessionId: row.sessionId as string,
              type: row.type as "shared" | "exclusive",
            });
          }
        }
      }

      if (conflicts.length > 0) {
        return {
          ok: false,
          reason: "conflict" as const,
          conflicts,
        };
      }

      const alreadyLockedBySession = new Set(
        (existingLocks.rows as Record<string, unknown>[])
          .filter((row) => row.sessionId === sessionId)
          .map((row) => row.filePath as string)
      );

      const newLocks = uniquePaths
        .filter((filePath) => !alreadyLockedBySession.has(filePath))
        .map((filePath) => ({
          sessionId,
          filePath,
          type: uniqueIntentsMap.get(filePath)!,
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
            type: fileLocks.type,
          })
          .from(fileLocks)
          .where(inArray(fileLocks.filePath, uniquePaths));

        return {
          ok: false,
          reason: "conflict" as const,
          conflicts: contestedLocks
            .filter((lock) => lock.sessionId !== sessionId)
            .map(lock => ({ filePath: lock.filePath, sessionId: lock.sessionId, type: lock.type as "shared" | "exclusive" })),
        };
      }
    });
  }

  /**
   * Checks if any of the requested files are already locked by another session.
   * If not, it creates new locks for the given session.
   * 
   * @param sessionId The Jules Session ID requesting the locks
   * @param intents List of absolute paths and their intents to be locked
   * @returns boolean true if locks were successfully acquired, false otherwise
   */
  static async requestLock(
    sessionId: string,
    intents: Array<{ filePath: string; type: "shared" | "exclusive" }>
  ): Promise<boolean> {
    const result = await LockManager.acquireLocks(sessionId, intents);
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
        type: fileLocks.type,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
