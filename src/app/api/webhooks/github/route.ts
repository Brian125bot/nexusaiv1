import { z } from "zod";
import { eq } from "drizzle-orm";
import { after } from "next/server";

import { db } from "@/db";
import { sessions, goals } from "@/db/schema";
import { reviewWebhookEvent } from "@/lib/auditor/auto-reviewer";
import { CORE_FILES, isCoreFile } from "@/lib/cascade-config";
import { getRequiredEnv, verifyGitHubSignature } from "@/lib/github/webhook";
import { LockManager } from "@/lib/registry/lock-manager";
import { githubClient } from "@/lib/github/octokit";

export const runtime = "nodejs";

const checkRunEventSchema = z.object({
  action: z.string(),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
  check_run: z.object({
    id: z.number().int().positive(),
    head_sha: z.string(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    output: z
      .object({
        title: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
      })
      .optional()
      .nullable(),
    pull_requests: z.array(
      z.object({
        head: z.object({ ref: z.string() }),
      })
    ).optional(),
  }),
});

const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().default(false),
    head: z.object({
      ref: z.string().min(1),
      sha: z.string().min(1),
    }),
  }),
});

const pushEventSchema = z.object({
  ref: z.string().min(1),
  after: z.string().min(1),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({ name: z.string().min(1).optional(), login: z.string().min(1).optional() }),
  }),
  sender: z.object({ login: z.string().min(1).optional() }).optional(),
  pusher: z.object({ name: z.string().min(1).optional() }).optional(),
  head_commit: z
    .object({
      message: z.string().optional(),
      author: z
        .object({
          username: z.string().optional(),
          name: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  commits: z
    .array(
      z.object({
        message: z.string().optional(),
        author: z
          .object({
            username: z.string().optional(),
            name: z.string().optional(),
          })
          .optional(),
        added: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

function parseBranchFromRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.replace("refs/heads/", "") : ref;
}

function isAutomatedCommit(payload: z.infer<typeof pushEventSchema>): boolean {
  const authorCandidates = [
    payload.sender?.login,
    payload.pusher?.name,
    payload.head_commit?.author?.username,
    payload.head_commit?.author?.name,
    ...payload.commits.flatMap((commit) => [commit.author?.username, commit.author?.name]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase());

  if (authorCandidates.some((author) => author.includes("jules"))) {
    return true;
  }

  const commitMessages = [
    payload.head_commit?.message,
    ...payload.commits.map((commit) => commit.message),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase());

  return commitMessages.some((message) => message.includes("[nexus-auto]"));
}

type WebhookFileChange = {
  filePath: string;
  diff: string;
  status: "added" | "modified" | "removed";
};

function collectPushFileChanges(payload: z.infer<typeof pushEventSchema>): WebhookFileChange[] {
  const precedence = { modified: 1, added: 2, removed: 3 } as const;
  const files = new Map<string, WebhookFileChange["status"]>();

  const addFile = (filePath: string, status: WebhookFileChange["status"]) => {
    const currentStatus = files.get(filePath);
    if (!currentStatus || precedence[status] >= precedence[currentStatus]) {
      files.set(filePath, status);
    }
  };

  for (const commit of payload.commits) {
    for (const filePath of commit.modified ?? []) addFile(filePath, "modified");
    for (const filePath of commit.added ?? []) addFile(filePath, "added");
    for (const filePath of commit.removed ?? []) addFile(filePath, "removed");
  }

  return [...files.entries()].map(([filePath, status]) => ({
    filePath,
    status,
    // Push payload does not include hunks; keep a non-empty placeholder for analyzer schema compatibility.
    diff: "Diff unavailable in GitHub push payload; analyze by file-level change metadata.",
  }));
}

function detectConfiguredCoreFiles(fileChanges: WebhookFileChange[]): string[] {
  return fileChanges
    .map((change) => change.filePath)
    .filter((filePath) => CORE_FILES.includes(filePath) || isCoreFile(filePath));
}

async function triggerCascadeAnalyze(req: Request, input: {
  sourceRepo: string;
  branch: string;
  commitSha: string;
  fileChanges: WebhookFileChange[];
}) {
  const endpoint = new URL("/api/cascade/analyze", req.url);
  const headers = new Headers({ "content-type": "application/json" });
  const authHeader = req.headers.get("authorization");
  const cookieHeader = req.headers.get("cookie");

  if (authHeader) headers.set("authorization", authHeader);
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      sourceRepo: input.sourceRepo,
      branch: input.branch,
      commitSha: input.commitSha,
      fileChanges: input.fileChanges,
      autoDispatch: true,
    }),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

export async function POST(req: Request) {
  try {
    const webhookSecret = getRequiredEnv("GITHUB_WEBHOOK_SECRET");
    getRequiredEnv("GITHUB_TOKEN");

    const rawBody = await req.text();
    const signature = req.headers.get("x-hub-signature-256");

    if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const eventType = req.headers.get("x-github-event");
    let payload: unknown;

    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (eventType === "check_run") {
      const parsed = checkRunEventSchema.safeParse(payload);
      if (!parsed.success) {
        return Response.json({ error: "Invalid check_run payload", issues: parsed.error.issues }, { status: 400 });
      }

      const { action, repository, check_run } = parsed.data;

      if (action !== "completed") {
        return Response.json({ ignored: true, reason: "check_run not completed" }, { status: 202 });
      }

      const headSha = check_run.head_sha;

      let session = await db.query.sessions.findFirst({
        where: eq(sessions.lastReviewedCommit, headSha),
      });

      // fallback: try to find by branch if lastReviewedCommit doesn't match and pull request exists
      const branchName = check_run.pull_requests?.[0]?.head.ref;
      if (!session && branchName) {
        session = await db.query.sessions.findFirst({
          where: eq(sessions.branchName, branchName),
        });
      }

      if (!session) {
         return Response.json({ ignored: true, reason: "No active session found for commit" }, { status: 202 });
      }

      if (["verifying", "completed", "failed"].includes(session.status)) {
        console.log(`[Webhook] Ignoring check_run: Session ${session.id} already in state ${session.status}`);
        return Response.json({ ignored: true, reason: `Session ${session.id} already in state ${session.status}` }, { status: 200 });
      }

      if (check_run.conclusion === "failure" || check_run.conclusion === "timed_out") {
        after(async () => {
          try {
            // CI failed, fetch raw logs from GitHub Actions if possible
            const rawLogs = await githubClient.getCheckRunLogs(
              repository.owner.login,
              repository.name,
              check_run.id
            );

            const errorLogs = rawLogs || check_run.output?.text || check_run.output?.summary || "CI Build Failed";

            // Mark session failed immediately
            await db
              .update(sessions)
              .set({
                status: "failed",
                lastError: String(errorLogs).substring(0, 5000), // Ensure we capture more context if available
              })
              .where(eq(sessions.id, session.id));

            if (session.remediationDepth >= 3) {
              console.log(`🛑 Nexus: Maximum remediation depth reached for session ${session.id} after CI failure.`);
              if (session.goalId) {
                await db.update(goals)
                  .set({ status: "drifted" })
                  .where(eq(goals.id, session.goalId));
              }
              return; // Stop early
            }


            // Fetch the internal analyze endpoint directly via localhost since we are the server
            // We use the triggerCascadeAnalyze pattern
            const endpoint = new URL("/api/cascade/analyze", req.url);
            const headers = new Headers({ "content-type": "application/json" });
            const authHeader = req.headers.get("authorization");
            const cookieHeader = req.headers.get("cookie");

            if (authHeader) headers.set("authorization", authHeader);
            if (cookieHeader) headers.set("cookie", cookieHeader);

            // Pass the logs and session ID to the analyze route for Ouroboros remediation
            const response = await fetch(endpoint.toString(), {
              method: "POST",
              headers,
              body: JSON.stringify({
                type: "remediation",
                sessionId: session.id,
                logs: String(errorLogs)
              }),
            });

            if (!response.ok) {
              const body = await response.text();
              throw new Error(`Failed to trigger auto-remediation: ${response.status} ${body}`);
            }

            // Keep the lastError updated for UI visibility
            await db.update(sessions)
              .set({ lastError: String(errorLogs).substring(0, 500) })
              .where(eq(sessions.id, session.id));

          } catch (err: unknown) {
            console.error("Error processing CI failure:", err);
            const errorMessage = err instanceof Error ? err.message : String(err);
            await db.update(sessions)
              .set({ status: "failed", lastError: errorMessage.substring(0, 5000) })
              .where(eq(sessions.id, session.id));
          }
        });

        return Response.json({ received: true, eventType, result: "ci_failed_remediation_triggered" });
      }

      if (check_run.conclusion === "success") {
        const primaryPipelines = ["Vercel", "build", "test", "ci"];
        const isPrimary = primaryPipelines.some(p => check_run.name.toLowerCase().includes(p.toLowerCase()));

        if (!isPrimary) {
           console.log(`[Webhook] Ignored non-primary check_run success: ${check_run.name}`);
           return Response.json({ ignored: true, reason: `check_run success ignored for non-primary pipeline: ${check_run.name}` }, { status: 200 });
        }

        // CI succeeded, trigger semantic auditor
        await db
          .update(sessions)
          .set({ status: "verifying" })
          .where(eq(sessions.id, session.id));

        console.log(`[Webhook] CI Signal Received: ${headSha} -> success. Updating Session ${session.id} to verifying.`);

        after(async () => {
          try {
            await reviewWebhookEvent({
              eventType: "push", // Treat as push to review latest sha
              owner: repository.owner.login,
              repo: repository.name,
              branch: branchName || session.branchName,
              sha: headSha,
            });
          } catch (err: unknown) {
            console.error("Auditor error:", err);
            // CRITICAL: Prevent silent failure state
            const errorMessage = err instanceof Error ? err.message : String(err);
            await db.update(sessions)
              .set({ status: "failed", lastError: errorMessage.substring(0, 5000) })
              .where(eq(sessions.id, session.id));
          }
        });

        return Response.json({ received: true, eventType, result: "verifying_started" });
      }

      return Response.json({ ignored: true, reason: `Ignored conclusion: ${check_run.conclusion}` }, { status: 202 });
    }

    if (eventType === "pull_request") {
      const parsed = pullRequestEventSchema.safeParse(payload);
      if (!parsed.success) {
        return Response.json({ error: "Invalid pull_request payload", issues: parsed.error.issues }, { status: 400 });
      }

      const { action, repository, pull_request: pr } = parsed.data;

      if (action === "closed") {
        // Find session linked to this PR branch
        const session = await db.query.sessions.findFirst({
          where: eq(sessions.branchName, pr.head.ref),
        });

        if (session && session.status !== "completed" && session.status !== "failed") {
          const newStatus = pr.merged ? "completed" : "failed";

          console.log(`🧹 Nexus: PR closed (${pr.merged ? 'merged' : 'unmerged'}). Transitioning session ${session.id} to ${newStatus} and releasing locks.`);

          await db
            .update(sessions)
            .set({
              status: newStatus,
              lastSyncedAt: new Date()
            })
            .where(eq(sessions.id, session.id));

          // Physically delete entries from the file_locks table
          await LockManager.releaseLocks(session.id);

          return Response.json({ received: true, eventType, result: "session_cleaned_up", sessionId: session.id, newStatus });
        }

        return Response.json({ ignored: true, reason: "No active session found for closed PR or already terminal" }, { status: 202 });
      }

      if (action !== "opened" && action !== "synchronize") {
        return Response.json({ ignored: true, reason: `Unsupported pull_request action: ${action}` }, { status: 202 });
      }

      const result = await reviewWebhookEvent({
        eventType: "pull_request",
        owner: repository.owner.login,
        repo: repository.name,
        branch: pr.head.ref,
        sha: pr.head.sha,
        prNumber: pr.number,
      });

      return Response.json({ received: true, eventType, result });
    }

    if (eventType === "push") {
      const parsed = pushEventSchema.safeParse(payload);
      if (!parsed.success) {
        return Response.json({ error: "Invalid push payload", issues: parsed.error.issues }, { status: 400 });
      }

      const { repository, ref, after } = parsed.data;
      const owner = repository.owner.login ?? repository.owner.name;

      if (!owner) {
        return Response.json({ error: "Push payload missing repository owner" }, { status: 400 });
      }

      if (isAutomatedCommit(parsed.data)) {
        return Response.json(
          { ignored: true, reason: "Automated commit detected (jules/[Nexus-Auto])" },
          { status: 202 },
        );
      }

      const sourceRepo = `${owner}/${repository.name}`;
      const branch = parseBranchFromRef(ref);
      const fileChanges = collectPushFileChanges(parsed.data);
      const coreFilesChanged = detectConfiguredCoreFiles(fileChanges);

      const result = await reviewWebhookEvent({
        eventType: "push",
        owner,
        repo: repository.name,
        branch,
        sha: after,
      });

      let cascadeTrigger:
        | {
          triggered: boolean;
          coreFilesChanged: string[];
          requestStatus?: number;
          requestAccepted?: boolean;
          requestBody?: unknown;
        }
        | undefined;

      if (coreFilesChanged.length > 0 && fileChanges.length > 0) {
        const cascadeResponse = await triggerCascadeAnalyze(req, {
          sourceRepo,
          branch,
          commitSha: after,
          fileChanges,
        });

        cascadeTrigger = {
          triggered: true,
          coreFilesChanged,
          requestStatus: cascadeResponse.status,
          requestAccepted: cascadeResponse.ok,
          requestBody: cascadeResponse.body,
        };
      } else {
        cascadeTrigger = {
          triggered: false,
          coreFilesChanged,
        };
      }

      return Response.json({ received: true, eventType, result, cascadeTrigger });
    }

    return Response.json({ ignored: true, reason: `Unsupported event type: ${eventType ?? "missing"}` }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process GitHub webhook";
    return Response.json({ error: message }, { status: 500 });
  }
}
