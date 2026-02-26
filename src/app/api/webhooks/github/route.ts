import { z } from "zod";

import { reviewWebhookEvent } from "@/lib/auditor/auto-reviewer";
import { getRequiredEnv, verifyGitHubSignature } from "@/lib/github/webhook";

export const runtime = "nodejs";

const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: z.object({
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
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
});

function parseBranchFromRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.replace("refs/heads/", "") : ref;
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

    if (eventType === "pull_request") {
      const parsed = pullRequestEventSchema.safeParse(payload);
      if (!parsed.success) {
        return Response.json({ error: "Invalid pull_request payload", issues: parsed.error.issues }, { status: 400 });
      }

      const { action, repository, pull_request: pr } = parsed.data;
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

      const result = await reviewWebhookEvent({
        eventType: "push",
        owner,
        repo: repository.name,
        branch: parseBranchFromRef(ref),
        sha: after,
      });

      return Response.json({ received: true, eventType, result });
    }

    return Response.json({ ignored: true, reason: `Unsupported event type: ${eventType ?? "missing"}` }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process GitHub webhook";
    return Response.json({ error: message }, { status: 500 });
  }
}
