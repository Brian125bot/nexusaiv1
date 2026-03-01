import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { goals, sessions } from "@/db/schema";
import { reviewWebhookEvent } from "@/lib/auditor/auto-reviewer";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const goal = await db.query.goals.findFirst({
      where: eq(goals.id, id),
    });

    if (!goal) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }

    // Find the latest session for this goal to get branch and SHA context
    const latestSession = await db.query.sessions.findFirst({
      where: eq(sessions.goalId, id),
      orderBy: [desc(sessions.createdAt)],
    });

    if (!latestSession || !latestSession.lastReviewedCommit) {
      return Response.json(
        { error: "No completed session found to re-audit" },
        { status: 400 }
      );
    }

    // Extract owner and repo from sourceRepo (format: owner/repo)
    const [owner, repo] = latestSession.sourceRepo.split("/");

    const result = await reviewWebhookEvent({
      eventType: "push",
      owner,
      repo,
      branch: latestSession.branchName,
      sha: latestSession.lastReviewedCommit,
    });

    return Response.json({ success: true, result });
  } catch (error) {
    console.error("Manual re-audit failed:", error);
    return Response.json(
      { error: "Failed to trigger re-audit" },
      { status: 500 }
    );
  }
}
