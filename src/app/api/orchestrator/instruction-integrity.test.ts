import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to share state between mocks and tests
const { mockLocks, releaseLocksMock, acquireLocksMock } = vi.hoisted(() => {
  const locks = new Map<string, string>(); // filePath -> sessionId
  return {
    mockLocks: locks,
    releaseLocksMock: vi.fn(async (sessionId: string) => {
      for (const [path, id] of Array.from(locks.entries())) {
        if (id === sessionId) {
          locks.delete(path);
        }
      }
    }),
    acquireLocksMock: vi.fn(async (sessionId: string, filePaths: string[]) => {
      const conflicts = filePaths
        .filter(path => locks.has(path) && locks.get(path) !== sessionId)
        .map(path => ({ filePath: path, sessionId: locks.get(path)! }));

      if (conflicts.length > 0) {
        return { ok: false, reason: "conflict", conflicts };
      }

      for (const path of filePaths) {
        locks.set(path, sessionId);
      }
      return { ok: true, lockedFiles: filePaths };
    }),
  };
});

const deleteMock = vi.fn();
const updateMock = vi.fn();
const returningMock = vi.fn();
const setMock = vi.fn();
const whereMock = vi.fn();

const schema = {
  sessions: { table: "sessions", id: "id", status: "status", lastError: "lastError" },
  fileLocks: { table: "file_locks", sessionId: "sessionId" },
};

vi.mock("@/db/schema", () => schema);

vi.mock("@/db", () => ({
  db: {
    delete: (...args: unknown[]) => {
      deleteMock(...args);
      return {
        where: (...whereArgs: unknown[]) => {
          whereMock(...whereArgs);
          return { returning: returningMock };
        },
      };
    },
    update: (...args: unknown[]) => {
      updateMock(...args);
      return {
        set: (...setArgs: unknown[]) => {
          setMock(...setArgs);
          return {
            where: (...whereArgs: unknown[]) => {
              whereMock(...whereArgs);
              return { returning: returningMock };
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  validateUser: vi.fn().mockResolvedValue("test-user"),
  authErrorResponse: vi.fn((error: unknown) => Response.json({ error }, { status: 401 })),
}));

vi.mock("@/lib/registry/lock-manager", () => ({
  LockManager: {
    releaseLocks: releaseLocksMock,
    acquireLocks: acquireLocksMock,
  },
}));

describe("POST /api/sessions/[id]/terminate - Escape Hatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocks.clear();

    returningMock.mockResolvedValue([{ id: "test-session-001" }]);
    whereMock.mockResolvedValue(undefined);
    setMock.mockResolvedValue(undefined);
  });

  it("should terminate a session and release its locks", async () => {
    const { POST } = await import("@/app/api/sessions/[id]/terminate/route");

    const req = new Request("http://localhost/api/sessions/test-session-001/terminate", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const context = {
      params: Promise.resolve({ id: "test-session-001" }),
    } as unknown as { params: Promise<{ id: string }> };

    const res = await POST(req, context);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe("test-session-001");

    expect(updateMock).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith({
      status: "failed",
      lastError: "Manually terminated by Admin/Test teardown",
    });

    expect(releaseLocksMock).toHaveBeenCalledWith("test-session-001");
  });

  it("should return 400 when session id is missing", async () => {
    const { POST } = await import("@/app/api/sessions/[id]/terminate/route");

    const req = new Request("http://localhost/api/sessions//terminate", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const context = {
      params: Promise.resolve({ id: "" }),
    } as unknown as { params: Promise<{ id: string }> };

    const res = await POST(req, context);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Session ID is required");
  });
});

describe("Instruction Integrity Test - Lock Cleanup State Machine", () => {
  let testSessionId: string | null = null;

  beforeEach(() => {
    testSessionId = "test-integrity-check-001";
  });

  afterEach(async () => {
    // Teardown: explicitly terminate the session to release locks
    if (testSessionId) {
      const { POST } = await import("@/app/api/sessions/[id]/terminate/route");
      const req = new Request(`http://localhost/api/sessions/${testSessionId}/terminate`, {
        method: "POST",
      });
      const context = {
        params: Promise.resolve({ id: testSessionId }),
      } as unknown as { params: Promise<{ id: string }> };

      await POST(req, context);
    }
  });

  it("should be able to run 10 times without lock contention", async () => {
    const { LockManager } = await import("@/lib/registry/lock-manager");

    for (let i = 0; i < 10; i++) {
      // 1. Acquire locks
      const result = await LockManager.acquireLocks(testSessionId!, ["file-A.ts", "file-B.ts"]);
      expect(result.ok).toBe(true);

      // 2. Verify they are held
      expect(mockLocks.get("file-A.ts")).toBe(testSessionId);

      // 3. Manually trigger cleanup (simulating the afterEach hook's logic within the loop for this test)
      const { POST } = await import("@/app/api/sessions/[id]/terminate/route");
      const req = new Request(`http://localhost/api/sessions/${testSessionId}/terminate`, {
        method: "POST",
      });
      const context = {
        params: Promise.resolve({ id: testSessionId }),
      } as unknown as { params: Promise<{ id: string }> };

      const res = await POST(req, context);
      expect(res.status).toBe(200);

      // 4. Verify they are released
      expect(mockLocks.has("file-A.ts")).toBe(false);
      expect(mockLocks.has("file-B.ts")).toBe(false);
    }
  });

  it("should fail if cleanup is NOT performed", async () => {
    const { LockManager } = await import("@/lib/registry/lock-manager");
    
    // Acquire locks with one session
    await LockManager.acquireLocks("other-session", ["shared-file.ts"]);
    
    // Try to acquire with our test session - should fail
    const result = await LockManager.acquireLocks(testSessionId!, ["shared-file.ts"]);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("conflict");
    }

    // Clean up the other session so afterEach doesn't fail on orphaned global state
    await LockManager.releaseLocks("other-session");
  });
});
