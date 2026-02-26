import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LockManager } from "./lock-manager";
import { db } from "@/db";
import { sessions, fileLocks } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("LockManager", () => {
  const TEST_SESSION_1 = "test-session-1";
  const TEST_SESSION_2 = "test-session-2";

  beforeAll(async () => {
    // Clean up if any leftovers (should be clean though)
    await db.delete(fileLocks);
    await db.delete(sessions);

    // Create test sessions
    await db.insert(sessions).values([
      { id: TEST_SESSION_1, branchName: "feature/test-1" },
      { id: TEST_SESSION_2, branchName: "feature/test-2" },
    ]);
  });

  afterAll(async () => {
    await db.delete(fileLocks);
    await db.delete(sessions);
  });

  it("should successfully lock a file", async () => {
    const filePath = "/src/app/page.tsx";
    const result = await LockManager.requestLock(TEST_SESSION_1, [filePath]);
    expect(result).toBe(true);
    
    const conflicts = await LockManager.getConflictStatus([filePath]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].sessionId).toBe(TEST_SESSION_1);
  });

  it("should fail to lock an already locked file by another session", async () => {
    const filePath = "/src/app/page.tsx"; // Already locked by session 1
    const result = await LockManager.requestLock(TEST_SESSION_2, [filePath]);
    expect(result).toBe(false);
  });

  it("should allow the same session to lock the same file again (idempotent-ish)", async () => {
    const filePath = "/src/app/page.tsx";
    const result = await LockManager.requestLock(TEST_SESSION_1, [filePath]);
    expect(result).toBe(true);
  });

  it("should allow locking multiple files at once", async () => {
    const filePaths = ["/src/lib/utils.ts", "/src/lib/db.ts"];
    const result = await LockManager.requestLock(TEST_SESSION_2, filePaths);
    expect(result).toBe(true);

    const conflicts = await LockManager.getConflictStatus(filePaths);
    expect(conflicts.length).toBe(2);
    expect(conflicts.every(c => c.sessionId === TEST_SESSION_2)).toBe(true);
  });

  it("should fail if ANY file in the batch is locked by another session", async () => {
    const filePaths = ["/src/app/layout.tsx", "/src/app/page.tsx"]; // page.tsx is locked by session 1
    const result = await LockManager.requestLock(TEST_SESSION_2, filePaths);
    expect(result).toBe(false);

    // layout.tsx should NOT have been locked
    const conflicts = await LockManager.getConflictStatus(["/src/app/layout.tsx"]);
    expect(conflicts.length).toBe(0);
  });

  it("should release locks", async () => {
    await LockManager.releaseLocks(TEST_SESSION_1);
    const conflicts = await LockManager.getConflictStatus(["/src/app/page.tsx"]);
    expect(conflicts.length).toBe(0);
  });
});
