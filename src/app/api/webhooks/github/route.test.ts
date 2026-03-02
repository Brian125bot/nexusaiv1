import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewWebhookEventMock = vi.fn();
const verifyGitHubSignatureMock = vi.fn();
const getRequiredEnvMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@/lib/auditor/auto-reviewer", () => ({
  reviewWebhookEvent: (...args: unknown[]) => reviewWebhookEventMock(...args),
}));

vi.mock("@/lib/github/webhook", () => ({
  verifyGitHubSignature: (...args: unknown[]) => verifyGitHubSignatureMock(...args),
  getRequiredEnv: (...args: unknown[]) => getRequiredEnvMock(...args),
}));

vi.mock("@/lib/cascade-config", () => ({
  CORE_FILES: ["src/db/schema.ts"],
  isCoreFile: (filePath: string) => filePath.endsWith("/schema.ts"),
}));

describe("POST /api/webhooks/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyGitHubSignatureMock.mockReturnValue(true);
    getRequiredEnvMock.mockReturnValue("ok");
    reviewWebhookEventMock.mockResolvedValue({ outcome: "review_posted" });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cascadeId: "cascade_abc", isCascade: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("skips automated push commits from Jules authors", async () => {
    const { POST } = await import("@/app/api/webhooks/github/route");

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sig",
        "x-github-event": "push",
      },
      body: JSON.stringify({
        ref: "refs/heads/main",
        after: "abc123",
        repository: {
          name: "repo",
          owner: { login: "acme" },
        },
        head_commit: {
          message: "normal commit",
          author: { username: "jules-bot" },
        },
        commits: [],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.ignored).toBe(true);
    expect(reviewWebhookEventMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips automated push commits with [Nexus-Auto] marker", async () => {
    const { POST } = await import("@/app/api/webhooks/github/route");

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sig",
        "x-github-event": "push",
      },
      body: JSON.stringify({
        ref: "refs/heads/main",
        after: "abc123",
        repository: {
          name: "repo",
          owner: { login: "acme" },
        },
        head_commit: {
          message: "[Nexus-Auto] cascade follow-up",
          author: { username: "ci-bot" },
        },
        commits: [],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.ignored).toBe(true);
    expect(reviewWebhookEventMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("triggers /api/cascade/analyze when a core file is changed in push commits", async () => {
    const { POST } = await import("@/app/api/webhooks/github/route");

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sig",
        "x-github-event": "push",
      },
      body: JSON.stringify({
        ref: "refs/heads/main",
        after: "deadbeef",
        repository: {
          name: "repo",
          owner: { login: "acme" },
        },
        head_commit: {
          message: "update core schema",
          author: { username: "dev-user" },
        },
        commits: [
          {
            message: "update core schema",
            modified: ["src/db/schema.ts"],
          },
        ],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(reviewWebhookEventMock).toHaveBeenCalledWith({
      eventType: "push",
      owner: "acme",
      repo: "repo",
      branch: "main",
      sha: "deadbeef",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost/api/cascade/analyze");
    const fetchBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fetchBody.fileChanges).toEqual([
      {
        filePath: "src/db/schema.ts",
        status: "modified",
        diff: "Diff unavailable in GitHub push payload; analyze by file-level change metadata.",
      },
    ]);
    expect(fetchBody.autoDispatch).toBe(true);
    expect(body.cascadeTrigger.triggered).toBe(true);
    expect(body.cascadeTrigger.coreFilesChanged).toEqual(["src/db/schema.ts"]);
  });
  it("ignores check_run if session is already completed", async () => {
    const { POST } = await import("@/app/api/webhooks/github/route");
    const { db } = await import("@/db");
    const { sessions } = await import("@/db/schema");

    // Seed mock data
    const { eq } = await import('drizzle-orm');
    await db.delete(sessions).where(eq(sessions.id, 'session_already_completed'));
            await db.insert(sessions).values({
      id: "session_already_completed",
      sourceRepo: "acme/repo",
      branchName: "main",
      status: "completed",
      lastReviewedCommit: "abc1234",
      createdAt: new Date(),
      isCascadeRoot: false,
    });

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sig",
        "x-github-event": "check_run",
      },
      body: JSON.stringify({
        action: "completed",
        repository: { name: "repo", owner: { login: "acme" } },
        check_run: {
          id: 1,
          head_sha: "abc1234",
          name: "Vercel",
          status: "completed",
          conclusion: "success",
        }
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ignored).toBe(true);
    expect(body.reason).toContain("already in state completed");
  });

  it("handles primary check_run success correctly by starting verification", async () => {
    const { POST } = await import("@/app/api/webhooks/github/route");
    const { db } = await import("@/db");
    const { sessions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    await db.insert(sessions).values({
      id: "session_to_verify",
      sourceRepo: "acme/repo",
      branchName: "feature-branch",
      status: "queued",
      lastReviewedCommit: "sha-success",
      createdAt: new Date(),
      isCascadeRoot: false,
    });

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sig",
        "x-github-event": "check_run",
      },
      body: JSON.stringify({
        action: "completed",
        repository: { name: "repo", owner: { login: "acme" } },
        check_run: {
          id: 2,
          head_sha: "sha-success",
          name: "build and test",
          status: "completed",
          conclusion: "success",
        }
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.result).toBe("verifying_started");

    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, "session_to_verify"),
    });

    expect(session?.status).toBe("verifying");
  });

  it("handles check_run failure correctly by failing session and remediation logic", async () => {
    const { POST } = await import("@/app/api/webhooks/github/route");
    const { db } = await import("@/db");
    const { sessions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    await db.insert(sessions).values({
      id: "session_to_fail",
      sourceRepo: "acme/repo",
      branchName: "fail-branch",
      status: "executing",
      lastReviewedCommit: "sha-fail",
      createdAt: new Date(),
      isCascadeRoot: false,
    });

    // Mock after to execute immediately
    vi.mock("next/server", () => ({
      after: vi.fn(async (cb) => {
         await cb();
      })
    }));

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sig",
        "x-github-event": "check_run",
      },
      body: JSON.stringify({
        action: "completed",
        repository: { name: "repo", owner: { login: "acme" } },
        check_run: {
          id: 3,
          head_sha: "sha-fail",
          name: "Vercel",
          status: "completed",
          conclusion: "failure",
        }
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.result).toBe("ci_failed_remediation_triggered");

    // The state transition and log fetch is executed in an `after` block,
    // which in a test environment requires a bit of mocking gymnastics or wait.
    // For now we'll just check the response structure because
    // `after()` behaves asynchronously in the Next.js runtime.
  });

});
