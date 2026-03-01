import { randomUUID } from "crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { cascades, fileLocks, sessions, goals } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { julesClient } from "@/lib/jules/client";
import { LockManager } from "@/lib/registry/lock-manager";
import { orchestratorRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";
import { batchDispatchSchema, batchDispatchResponseSchema } from "@/lib/cascade/schemas";

export const runtime = "nodejs";

export type BatchDispatchResult = z.infer<typeof batchDispatchResponseSchema>;

/**
 * POST /api/orchestrator/batch
 * 
 * Dispatch multiple Jules sessions in parallel for cascade repair
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { success, limit, remaining, reset } = await orchestratorRatelimit.limit(userId);
  if (!success) {
    return rateLimitExceededResponse({ limit, remaining, reset });
  }

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = batchDispatchSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid request body",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { sourceRepo, baseBranch, cascadeId, jobs, goalId } = parsed.data;
  const batchId = `batch_${randomUUID()}`;
  const dispatchStartedAt = Date.now();

  try {
    // Step 1: Create or get parent goal for cascade
    let cascadeGoalId = goalId;
    if (!cascadeGoalId) {
      const [cascadeGoal] = await db
        .insert(goals)
        .values({
          title: `Cascade Repair: ${cascadeId}`,
          description: `Automated cascade repair - batch ${batchId}`,
          acceptanceCriteria: jobs.map(job => ({
            id: randomUUID(),
            text: job.prompt,
            met: false,
          })),
          status: "in-progress" as const,
        })
        .returning();

      cascadeGoalId = cascadeGoal.id;
    }

    await db
      .insert(cascades)
      .values({
        id: cascadeId,
        repairJobCount: jobs.length,
        summary: `Batch dispatch ${batchId}`,
        status: "analyzing",
      })
      .onConflictDoNothing();

    // Step 2: Dispatch all Jules sessions
    const conflictMap = new Map<string, string>();
    const sessionResults = await Promise.all(jobs.map(async (job) => {
      const internalSessionId = `cascade_${cascadeId}_${job.id}`;
      try {
        const sessionPrompt = buildCascadeSessionPrompt(job, cascadeId);
        await db.insert(sessions).values({
          id: internalSessionId,
          goalId: cascadeGoalId,
          cascadeId,
          sourceRepo,
          branchName: baseBranch,
          baseBranch,
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
            conflictMap.set(conflict.filePath, conflict.sessionId);
          });

          return {
            jobId: job.id,
            sessionId: "",
            sessionUrl: "",
            status: "conflict",
            lockedFiles: job.files,
          };
        }

        const session = await julesClient.createSession({
          prompt: sessionPrompt,
          sourceRepo,
          startingBranch: baseBranch,
          auditorContext: `cascade:${cascadeId};batch:${batchId};job:${job.id};files:${job.files.join(",")}`,
        });

        await db
          .update(sessions)
          .set({
            status: "executing",
            externalSessionId: session.id,
            julesSessionUrl: session.url,
            lastError: null,
            lastSyncedAt: new Date(),
          })
          .where(eq(sessions.id, internalSessionId));

        return {
          jobId: job.id,
          sessionId: session.id,
          sessionUrl: session.url,
          status: "dispatched",
          lockedFiles: job.files,
        };
      } catch (error) {
        console.error(`❌ Nexus: Failed to dispatch job ${job.id}:`, error);
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
        return {
          jobId: job.id,
          sessionId: "",
          sessionUrl: "",
          status: `failed: ${message}`,
          lockedFiles: job.files,
        };
      }
    }));

    const dispatchedCount = sessionResults.filter(s => s.status === "dispatched").length;
    const failedCount = sessionResults.filter(
      (session) => session.status.startsWith("failed") || session.status === "conflict",
    ).length;

    await db
      .update(cascades)
      .set({ status: dispatchedCount > 0 ? "dispatched" : "failed" })
      .where(eq(cascades.id, cascadeId));

    console.log(
      `✅ Nexus: Batch dispatch ${batchId} complete - ${dispatchedCount}/${jobs.length} sessions started`,
    );

    const lockConflicts = Array.from(conflictMap.entries()).map(([filePath, existingSessionId]) => ({
      filePath,
      existingSessionId,
    }));
    const telemetry = {
      dispatchLatencyMs: Date.now() - dispatchStartedAt,
      conflictCount: lockConflicts.length,
      dispatchedCount,
      failedCount,
    };

    if (dispatchedCount === 0 && lockConflicts.length > 0) {
      return Response.json(
        {
          error: "File lock conflicts detected",
          batchId,
          cascadeId,
          totalJobs: jobs.length,
          dispatchedCount,
          failedCount,
          sessions: sessionResults,
          lockConflicts,
          telemetry,
        },
        { status: 409 },
      );
    }

    console.log(
      `📊 Nexus: Batch telemetry ${batchId} (conflicts=${telemetry.conflictCount}, failed=${telemetry.failedCount}, latencyMs=${telemetry.dispatchLatencyMs})`,
    );

    return Response.json({
      batchId,
      cascadeId,
      totalJobs: jobs.length,
      dispatchedCount,
      failedCount,
      sessions: sessionResults,
      lockConflicts: lockConflicts.length > 0 ? lockConflicts : undefined,
      telemetry,
    });
  } catch (error) {
    console.error("❌ Nexus: Batch dispatch failed:", error);
    return Response.json(
      {
        error: "Batch dispatch failed",
        message: error instanceof Error ? error.message : "Unknown error",
        batchId,
        cascadeId,
      },
      { status: 500 },
    );
  }
}

/**
 * Build the session prompt for a cascade repair job
 */
function buildCascadeSessionPrompt(
  job: { id: string; files: string[]; prompt: string; priority: string; estimatedImpact: string },
  cascadeId: string,
): string {
  return [
    `## 🌊 Nexus Cascade Repair Task`,
    ``,
    `**Cascade ID:** ${cascadeId}`,
    `**Job ID:** ${job.id}`,
    `**Priority:** ${job.priority.toUpperCase()}`,
    `**Estimated Impact:** ${job.estimatedImpact}`,
    ``,
    `### Files to Repair`,
    ...job.files.map(f => `- \`${f}\``),
    ``,
    `### Repair Instructions`,
    job.prompt,
    ``,
    `### Constraints`,
    `- Only modify the files listed above`,
    `- Ensure all imports and type references are updated correctly`,
    `- Check for TypeScript errors before committing`,
    `- Run existing tests if available`,
    `- Create a single PR with all changes for this job`,
    ``,
    `### Context`,
    `This is part of a larger cascade repair operation. Multiple AI agents are working`,
    `in parallel to fix breaking changes across the codebase. Focus only on your assigned files.`,
  ].join("\n");
}
