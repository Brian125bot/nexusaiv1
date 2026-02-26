import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstSessionMock = vi.fn();

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
  },
}));

describe("reviewWebhookEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it("skips duplicate commit review when commit already reviewed", async () => {
    findFirstSessionMock.mockResolvedValueOnce({
      id: "sess-1",
      goalId: "goal-1",
      lastReviewedCommit: "abc123",
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
  });
});
