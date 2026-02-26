import { eq, or } from "drizzle-orm";

import { db } from "@/db";
import { fileLocks, goals, sessions } from "@/db/schema";
import { julesClient } from "@/lib/jules/client";
import { mapJulesStatusToRegistryStatus } from "@/lib/jules/status-map";

type SyncInput = {
  sessionId?: string;
  externalSessionId?: string;
};

type ReviewArtifact = {
  type: "pull_request";
  url: string;
  sessionExternalId: string;
  createdAt: string;
};

export async function syncSessionStatus(input: SyncInput) {
  if (!input.sessionId && !input.externalSessionId) {
    throw new Error("sessionId or externalSessionId is required");
  }

  const filters = [
    input.sessionId ? eq(sessions.id, input.sessionId) : undefined,
    input.externalSessionId ? eq(sessions.externalSessionId, input.externalSessionId) : undefined,
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);

  const session = await db.query.sessions.findFirst({
    where: filters.length === 1 ? filters[0] : or(filters[0], filters[1]),
  });

  if (!session) {
    throw new Error("Session not found");
  }

  if (!session.externalSessionId) {
    throw new Error("Session has no external Jules session ID");
  }

  const julesSession = await julesClient.getSession(session.externalSessionId);
  const mappedStatus = mapJulesStatusToRegistryStatus(julesSession.status);

  if (mappedStatus) {
    await db
      .update(sessions)
      .set({
        status: mappedStatus,
        julesSessionUrl: julesSession.url ?? session.julesSessionUrl,
        lastSyncedAt: new Date(),
        lastError: null,
      })
      .where(eq(sessions.id, session.id));
  }

  const prUrl = julesSession.outputs?.pullRequest?.url;

  if (mappedStatus === "completed") {
    if (session.goalId && prUrl) {
      const goal = await db.query.goals.findFirst({ where: eq(goals.id, session.goalId) });

      if (goal) {
        const artifacts = (goal.reviewArtifacts ?? []) as ReviewArtifact[];
        const alreadyExists = artifacts.some(
          (artifact) =>
            artifact.type === "pull_request" &&
            artifact.url === prUrl &&
            artifact.sessionExternalId === session.externalSessionId,
        );

        if (!alreadyExists) {
          artifacts.push({
            type: "pull_request",
            url: prUrl,
            sessionExternalId: session.externalSessionId,
            createdAt: new Date().toISOString(),
          });

          await db
            .update(goals)
            .set({ reviewArtifacts: artifacts })
            .where(eq(goals.id, session.goalId));
        }
      }
    }

    await db.delete(fileLocks).where(eq(fileLocks.sessionId, session.id));
  }

  if (mappedStatus === "failed") {
    await db.delete(fileLocks).where(eq(fileLocks.sessionId, session.id));
  }

  const updated = await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) });

  return {
    session: updated,
    externalStatus: julesSession.status,
    pullRequestUrl: prUrl ?? null,
  };
}
