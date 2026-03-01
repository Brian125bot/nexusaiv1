import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { sessions, fileLocks, goals, cascades } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import {
  analyzeCascade,
} from "@/lib/auditor/cascade-engine";
import { julesClient } from "@/lib/jules/client";
import { LockManager } from "@/lib/registry/lock-manager";
import { cascadeRequestSchema, cascadeResponseSchema } from "@/lib/cascade/schemas";

export const runtime = "nodejs";

export type CascadeDispatchResult = z.infer<typeof cascadeResponseSchema>;

/**
 * POST /api/cascade/analyze
 * 
 * Analyze the blast radius of core file changes and optionally dispatch repair agents
 */
export async function POST(req: Request) {
  try {
    await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = cascadeRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid request body",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { sourceRepo, branch, commitSha, fileChanges, goalId, autoDispatch } = parsed.data;

  // Generate cascade ID
  const cascadeId = `cascade_${commitSha.slice(0, 8)}_${Date.now()}`;
  const dispatchStartedAt = Date.now();

  try {
    // Step 1: Analyze the blast radius
    console.log(`🔍 Nexus: Analyzing cascade for ${cascadeId}`);
    const analysis = await analyzeCascade(fileChanges);

    if (!analysis.isCascade) {
      return Response.json({
        cascadeId,
        isCascade: false,
        coreFilesChanged: analysis.coreFilesChanged,
        downstreamFiles: [],
        repairJobs: [],
        summary: analysis.summary,
        confidence: analysis.confidence,
      });
    }

    console.log(
      `🌊 Nexus: Cascade detected - ${analysis.coreFilesChanged.length} core files, ${analysis.repairJobs.length} repair jobs`,
    );

    // Record the cascade in the database
    await db.insert(cascades).values({
      id: cascadeId,
      coreFilesChanged: analysis.coreFilesChanged,
      downstreamFiles: analysis.downstreamFiles,
      repairJobCount: analysis.repairJobs.length,
      summary: analysis.summary,
      status: "analyzing",
    }).onConflictDoNothing();

    // Step 2: Optionally dispatch repair sessions
    let dispatchedSessions: Array<{ jobId: string; sessionId: string; status: string }> | undefined;

    if (autoDispatch && analysis.repairJobs.length > 0) {
      console.log(`🚀 Nexus: Auto-dispatching ${analysis.repairJobs.length} repair sessions`);

      // Create a parent goal for the cascade if not provided
      let cascadeGoalId = goalId;
      if (!cascadeGoalId) {
        const cascadeGoal = await db.transaction(async (tx) => {
          const [goalResult] = await tx
            .insert(goals)
            .values({
              title: `Cascade Repair: ${analysis.coreFilesChanged.join(", ")}`,
              description: `Automated cascade repair triggered by commit ${commitSha.slice(0, 8)}`,
              acceptanceCriteria: analysis.repairJobs.map(job => ({
                id: randomUUID(),
                text: job.prompt,
                met: false,
                reasoning: null,
                files: job.files,
              })),
              status: "in-progress" as const,
            })
            .returning();

          return goalResult;
        });

        cascadeGoalId = cascadeGoal.id;
      }

      const conflictSet = new Map<string, string>();
      dispatchedSessions = [];

      for (const job of analysis.repairJobs) {
        const internalSessionId = `cascade_${cascadeId}_${job.id}`;
        const sessionPrompt = buildCascadeSessionPrompt(job, cascadeId);

        await db.insert(sessions).values({
          id: internalSessionId,
          goalId: cascadeGoalId,
          cascadeId,
          sourceRepo,
          branchName: branch,
          baseBranch: branch,
          status: "queued",
        });

        const lockResult = await LockManager.acquireLocks(internalSessionId, job.files);
        if (!lockResult.ok) {
          const conflictMessage = `Lock conflict on ${lockResult.conflicts.map((conflict) => conflict.filePath).join(", ")}`;
          await db
            .update(sessions)
            .set({
              status: "failed",
              lastError: conflictMessage,
              lastSyncedAt: new Date(),
            })
            .where(eq(sessions.id, internalSessionId));

          lockResult.conflicts.forEach((conflict) => {
            conflictSet.set(conflict.filePath, conflict.sessionId);
          });

          dispatchedSessions.push({
            jobId: job.id,
            sessionId: "",
            status: "conflict",
          });
          continue;
        }

        try {
          const createdSession = await julesClient.createSession({
            prompt: sessionPrompt,
            sourceRepo,
            startingBranch: branch,
            auditorContext: `cascade:${cascadeId};job:${job.id};files:${job.files.join(",")}`,
          });

          await db
            .update(sessions)
            .set({
              status: "executing",
              externalSessionId: createdSession.id,
              julesSessionUrl: createdSession.url,
              lastError: null,
              lastSyncedAt: new Date(),
            })
            .where(eq(sessions.id, internalSessionId));

          dispatchedSessions.push({
            jobId: job.id,
            sessionId: createdSession.id,
            status: "dispatched",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          await db
            .update(sessions)
            .set({
              status: "failed",
              lastError: `failed: ${message}`,
              lastSyncedAt: new Date(),
            })
            .where(eq(sessions.id, internalSessionId));
          await db.delete(fileLocks).where(eq(fileLocks.sessionId, internalSessionId));
          dispatchedSessions.push({
            jobId: job.id,
            sessionId: "",
            status: `failed: ${message}`,
          });
        }
      }

      const dispatchedCount = dispatchedSessions.filter((session) => session.status === "dispatched").length;
      const failedCount = dispatchedSessions.filter(
        (session) => session.status === "conflict" || session.status.startsWith("failed"),
      ).length;
      const telemetry = {
        dispatchLatencyMs: Date.now() - dispatchStartedAt,
        conflictCount: conflictSet.size,
        dispatchedCount,
        failedCount,
      };
      await db
        .update(cascades)
        .set({ status: dispatchedCount > 0 ? "dispatched" : "failed" })
        .where(eq(cascades.id, cascadeId));

      console.log(
        `✅ Nexus: Cascade dispatch complete - ${dispatchedCount}/${dispatchedSessions.length} sessions started (conflicts=${telemetry.conflictCount}, latencyMs=${telemetry.dispatchLatencyMs})`,
      );

      if (dispatchedCount === 0 && conflictSet.size > 0) {
        return Response.json(
          {
            error: "File lock conflicts detected",
            conflicts: Array.from(conflictSet.entries()).map(([filePath, sessionId]) => ({
              filePath,
              sessionId,
            })),
            cascadeId,
            isCascade: true,
            dispatchedSessions,
            telemetry,
          },
          { status: 409 },
        );
      }
    }

    return Response.json({
      cascadeId,
      isCascade: analysis.isCascade,
      coreFilesChanged: analysis.coreFilesChanged,
      downstreamFiles: analysis.downstreamFiles,
      repairJobs: analysis.repairJobs,
      dispatchedSessions,
      summary: analysis.summary,
      confidence: analysis.confidence,
      telemetry:
        autoDispatch && dispatchedSessions
          ? {
              dispatchLatencyMs: Date.now() - dispatchStartedAt,
              conflictCount: dispatchedSessions.filter((session) => session.status === "conflict")
                .length,
              dispatchedCount: dispatchedSessions.filter((session) => session.status === "dispatched")
                .length,
              failedCount: dispatchedSessions.filter(
                (session) =>
                  session.status === "conflict" || session.status.startsWith("failed"),
              ).length,
            }
          : undefined,
    });
  } catch (error) {
    console.error("❌ Nexus: Cascade analysis failed:", error);
    return Response.json(
      {
        error: "Cascade analysis failed",
        message: error instanceof Error ? error.message : "Unknown error",
        cascadeId,
      },
      { status: 500 },
    );
  }
}

function buildCascadeSessionPrompt(
  job: { id: string; files: string[]; prompt: string; priority: string; estimatedImpact: string },
  cascadeId: string,
): string {
  return [
    "## Cascade Repair Task",
    "",
    `**Cascade ID:** ${cascadeId}`,
    `**Job ID:** ${job.id}`,
    `**Priority:** ${job.priority.toUpperCase()}`,
    `**Estimated Impact:** ${job.estimatedImpact}`,
    "",
    "### Files to Repair",
    ...job.files.map((file) => `- ${file}`),
    "",
    "### Repair Instructions",
    job.prompt,
    "",
    "### Constraints",
    "- Only modify the files listed above",
    "- Ensure all imports and type references are updated correctly",
    "- Run tests if available",
    "- Create a single PR with all changes",
  ].join("\n");
}
