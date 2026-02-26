import { beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.fn();
const updateMock = vi.fn();

const valuesMock = vi.fn();
const onConflictDoNothingMock = vi.fn();
const setMock = vi.fn();
const whereMock = vi.fn();

const acquireLocksMock = vi.fn();
const createSessionMock = vi.fn();

const schema = {
  sessions: { table: "sessions" },
  fileLocks: { table: "file_locks" },
  goals: { table: "goals" },
  cascades: { table: "cascades" },
};

vi.mock("@/db/schema", () => schema);

vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  },
}));

vi.mock("@/lib/auth/session", () => ({
  validateUser: vi.fn().mockResolvedValue("test-user"),
  authErrorResponse: vi.fn((error: unknown) => Response.json({ error }, { status: 401 })),
}));

vi.mock("@/lib/rate-limit", () => ({
  orchestratorRatelimit: {
    limit: vi.fn().mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60_000,
    }),
  },
  rateLimitExceededResponse: vi.fn(),
}));

vi.mock("@/lib/registry/lock-manager", () => ({
  LockManager: {
    acquireLocks: (...args: unknown[]) => acquireLocksMock(...args),
  },
}));

vi.mock("@/lib/jules/client", () => ({
  julesClient: {
    createSession: (...args: unknown[]) => createSessionMock(...args),
  },
}));

describe("POST /api/orchestrator/batch conflict handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    onConflictDoNothingMock.mockResolvedValue(undefined);
    valuesMock.mockImplementation((payload: unknown) => {
      if ((payload as { id?: string })?.id === "cascade-1") {
        return { onConflictDoNothing: onConflictDoNothingMock };
      }
      return Promise.resolve(undefined);
    });
    insertMock.mockReturnValue({ values: valuesMock });

    whereMock.mockResolvedValue(undefined);
    setMock.mockReturnValue({ where: whereMock });
    updateMock.mockReturnValue({ set: setMock });

    acquireLocksMock.mockResolvedValue({
      ok: false,
      reason: "conflict",
      conflicts: [{ filePath: "src/lib/a.ts", sessionId: "existing-session-1" }],
    });
  });

  it("returns 409 with lockConflicts and telemetry when all jobs conflict", async () => {
    const { POST } = await import("@/app/api/orchestrator/batch/route");

    const req = new Request("http://localhost/api/orchestrator/batch", {
      method: "POST",
      body: JSON.stringify({
        sourceRepo: "acme/repo",
        baseBranch: "main",
        cascadeId: "cascade-1",
        goalId: "550e8400-e29b-41d4-a716-446655440000",
        jobs: [
          {
            id: "job-1",
            files: ["src/lib/a.ts"],
            prompt: "Fix imports",
            priority: "high",
            estimatedImpact: "high",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("File lock conflicts detected");
    expect(body.lockConflicts).toEqual([
      { filePath: "src/lib/a.ts", existingSessionId: "existing-session-1" },
    ]);
    expect(body.telemetry).toMatchObject({
      conflictCount: 1,
      dispatchedCount: 0,
      failedCount: 1,
    });
    expect(typeof body.telemetry.dispatchLatencyMs).toBe("number");
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
