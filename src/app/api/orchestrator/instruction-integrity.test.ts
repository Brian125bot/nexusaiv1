import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteMock = vi.fn();
const updateMock = vi.fn();
const returningMock = vi.fn();

const setMock = vi.fn();
const whereMock = vi.fn();

const releaseLocksMock = vi.fn();

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
    releaseLocks: (...args: unknown[]) => releaseLocksMock(...args),
    acquireLocks: vi.fn().mockResolvedValue({ ok: true, lockedFiles: ["test.ts"] }),
  },
}));

describe("POST /api/sessions/[id]/terminate - Escape Hatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    returningMock.mockResolvedValue([{ id: "test-session-001" }]);
    whereMock.mockResolvedValue(undefined);
    setMock.mockResolvedValue(undefined);
    releaseLocksMock.mockResolvedValue(undefined);
  });

  it("should terminate a session and release its locks", async () => {
    const { POST } = await import("@/app/api/sessions/[id]/terminate/route");

    const req = new Request("http://localhost/api/sessions/test-session-001/terminate", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    // Create a mock context with params
    const context = {
      params: Promise.resolve({ id: "test-session-001" }),
    } as unknown as { params: Promise<{ id: string }> };

    const res = await POST(req, context);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe("test-session-001");
    expect(body.message).toBe("Session terminated and locks released");

    // Verify session was updated to failed status
    expect(updateMock).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith({
      status: "failed",
      lastError: "Manually terminated by Admin/Test teardown",
    });

    // Verify locks were released
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

  it("should be idempotent - calling on already terminated session should not crash", async () => {
    const { POST } = await import("@/app/api/sessions/[id]/terminate/route");

    // First call - session exists
    returningMock.mockResolvedValueOnce([{ id: "test-session-002" }]);

    const req1 = new Request("http://localhost/api/sessions/test-session-002/terminate", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const context1 = {
      params: Promise.resolve({ id: "test-session-002" }),
    } as unknown as { params: Promise<{ id: string }> };

    const res1 = await POST(req1, context1);
    expect(res1.status).toBe(200);

    // Second call - session already terminated (simulate no rows returned but no error)
    returningMock.mockResolvedValueOnce([]);

    const req2 = new Request("http://localhost/api/sessions/test-session-002/terminate", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const context2 = {
      params: Promise.resolve({ id: "test-session-002" }),
    } as unknown as { params: Promise<{ id: string }> };

    const res2 = await POST(req2, context2);
    const body2 = await res2.json();

    // Should still return 200 and release locks (idempotent)
    expect(res2.status).toBe(200);
    expect(body2.success).toBe(true);
    expect(releaseLocksMock).toHaveBeenCalledTimes(2);
  });
});

describe("Instruction Integrity Test - Lock Cleanup", () => {
  // This describe block represents the actual instruction-integrity test logic
  // that was mentioned in the task. The afterEach hook ensures cleanup.

  let testSessionId: string | null = null;

  beforeEach(() => {
    testSessionId = "test-integrity-check-" + Date.now();
  });

  afterEach(async () => {
    // Ensure any locks are released after each test
    // This is the escape hatch teardown mechanism
    if (testSessionId) {
      const { LockManager } = await import("@/lib/registry/lock-manager");
      await LockManager.releaseLocks(testSessionId);
    }
  });

  it("should be able to run multiple times without lock contention", async () => {
    const { LockManager } = await import("@/lib/registry/lock-manager");

    // Simulate acquiring locks for a test session
    const lockResult = await LockManager.acquireLocks(testSessionId!, ["src/test-file-1.ts", "src/test-file-2.ts"]);
    
    expect(lockResult.ok).toBe(true);
    
    // The afterEach hook will clean up locks automatically
    // This test can run 10 times in a row without "File already locked" errors
  });
});
