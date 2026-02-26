import { beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.fn();
const updateMock = vi.fn();

const valuesMock = vi.fn();
const onConflictDoNothingMock = vi.fn();
const setMock = vi.fn();
const whereMock = vi.fn();

const acquireLocksMock = vi.fn();
const analyzeCascadeMock = vi.fn();
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
  },
}));

vi.mock("@/lib/auth/session", () => ({
  validateUser: vi.fn().mockResolvedValue("test-user"),
  authErrorResponse: vi.fn((error: unknown) => Response.json({ error }, { status: 401 })),
}));

vi.mock("@/lib/auditor/cascade-engine", () => ({
  analyzeCascade: (...args: unknown[]) => analyzeCascadeMock(...args),
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

describe("POST /api/cascade/analyze conflict handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    onConflictDoNothingMock.mockResolvedValue(undefined);
    valuesMock.mockImplementation((payload: unknown) => {
      if ((payload as { id?: string })?.id?.toString().startsWith("cascade_")) {
        return { onConflictDoNothing: onConflictDoNothingMock };
      }
      return Promise.resolve(undefined);
    });
    insertMock.mockReturnValue({ values: valuesMock });

    whereMock.mockResolvedValue(undefined);
    setMock.mockReturnValue({ where: whereMock });
    updateMock.mockReturnValue({ set: setMock });

    analyzeCascadeMock.mockResolvedValue({
      isCascade: true,
      coreFilesChanged: ["src/db/schema.ts"],
      downstreamFiles: ["src/lib/a.ts"],
      repairJobs: [
        {
          id: "job-1",
          files: ["src/lib/a.ts"],
          prompt: "Fix imports",
          priority: "high",
          estimatedImpact: "high",
        },
      ],
      summary: "cascade",
      confidence: 0.9,
    });

    acquireLocksMock.mockResolvedValue({
      ok: false,
      reason: "conflict",
      conflicts: [{ filePath: "src/lib/a.ts", sessionId: "existing-session-1" }],
    });
  });

  it("returns 409 with conflict details and telemetry when dispatch is fully blocked", async () => {
    const { POST } = await import("@/app/api/cascade/analyze/route");

    const req = new Request("http://localhost/api/cascade/analyze", {
      method: "POST",
      body: JSON.stringify({
        sourceRepo: "acme/repo",
        branch: "main",
        commitSha: "abc12345",
        goalId: "550e8400-e29b-41d4-a716-446655440000",
        autoDispatch: true,
        fileChanges: [{ filePath: "src/db/schema.ts", diff: "diff", status: "modified" }],
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("File lock conflicts detected");
    expect(body.conflicts).toEqual([
      { filePath: "src/lib/a.ts", sessionId: "existing-session-1" },
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
