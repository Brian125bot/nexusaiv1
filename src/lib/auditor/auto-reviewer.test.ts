import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstSessionMock = vi.fn();
const releaseLocksMock = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      sessions: {
        findFirst: (...args: unknown[]) => findFirstSessionMock(...args),
      },
      goals: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(),
  },
}));

vi.mock("@/lib/github/octokit", () => ({
  githubClient: {
    getCommitDiff: vi.fn(),
    getPullRequestDiff: vi.fn(),
    postPullRequestComment: vi.fn(),
    postCommitComment: vi.fn(),
    findOpenPullRequestNumber: vi.fn(),
    mergePullRequest: vi.fn(),
  },
}));

vi.mock("@/lib/registry/lock-manager", () => ({
  LockManager: {
    releaseLocks: (...args: unknown[]) => releaseLocksMock(...args),
    transferLocks: vi.fn(),
  },
}));

describe("reviewWebhookEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseLocksMock.mockResolvedValue(undefined);
  });

  it("returns no_active_session when no active session matches branch/repo", async () => {
    findFirstSessionMock.mockResolvedValueOnce(undefined);

    const { reviewWebhookEvent } = await import("@/lib/auditor/auto-reviewer");

    const result = await reviewWebhookEvent({
      eventType: "push",
      owner: "acme",
      repo: "nexus",
      branch: "feature/unknown",
      sha: "abc123",
    });

    expect(result).toEqual({ outcome: "no_active_session" });
  }, 10000);

  it("skips duplicate commit review when commit already reviewed", async () => {
    findFirstSessionMock.mockResolvedValueOnce({
      id: "sess-1",
      goalId: "goal-1",
      sourceRepo: "acme/nexus",
      branchName: "feature/a",
      status: "executing",
    });
    findFirstSessionMock.mockResolvedValueOnce({
      id: "sess-1",
      goalId: "goal-1",
      lastReviewedCommit: "abc123",
      sourceRepo: "acme/nexus",
      branchName: "feature/a",
      status: "executing",
    });

    const { reviewWebhookEvent } = await import("@/lib/auditor/auto-reviewer");

    const result = await reviewWebhookEvent({
      eventType: "push",
      owner: "acme",
      repo: "nexus",
      branch: "feature/a",
      sha: "abc123",
    });

    expect(result).toEqual({
      outcome: "duplicate_commit_skipped",
      sessionId: "sess-1",
      goalId: "goal-1",
    });
    expect(releaseLocksMock).toHaveBeenCalledWith("sess-1");
  });
});
