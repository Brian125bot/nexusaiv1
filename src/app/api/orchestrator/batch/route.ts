import { randomUUID } from "crypto";

import { z } from "zod";

import { db } from "@/db";
import { fileLocks, sessions, goals } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { julesClient } from "@/lib/jules/client";
import { orchestratorRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Schema for batch dispatch request
 */
const batchDispatchSchema = z.object({
  sourceRepo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().min(1),
  cascadeId: z.string().min(1),
  jobs: z.array(
    z.object({
      id: z.string().min(1),
      files: z.array(z.string().min(1)),
      prompt: z.string().min(1),
      priority: z.enum(["high", "medium", "low"]),
      estimatedImpact: z.string().min(1),
    }),
  ),
  goalId: z.string().uuid().optional(),
});

/**
 * Schema for batch dispatch response
 */
const batchDispatchResponseSchema = z.object({
  batchId: z.string(),
  cascadeId: z.string(),
  totalJobs: z.number(),
  dispatchedCount: z.number(),
  failedCount: z.number(),
  sessions: z.array(
    z.object({
      jobId: z.string(),
      sessionId: z.string(),
      sessionUrl: z.string().url(),
      status: z.string(),
      lockedFiles: z.array(z.string()),
    }),
  ),
  lockConflicts: z
    .array(
      z.object({
        filePath: z.string(),
        existingSessionId: z.string(),
      }),
    )
    .optional(),
});

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

  try {
    // Step 1: Collect all files that need to be locked
    const allFilesToLock = new Set<string>();
    for (const job of jobs) {
      for (const file of job.files) {
        allFilesToLock.add(file);
      }
    }

    const lockEntries = Array.from(allFilesToLock).map(filePath => ({
      sessionId: `cascade_${cascadeId}_${filePath.replace(/\//g, "_")}`,
      filePath,
    }));

    // Step 2: Try to acquire all locks atomically
    const lockResult = await db.transaction(async (tx) => {
      // Check for existing locks - use array filtering since drizzle doesn't support .in() on text columns
      const allFilePaths = Array.from(allFilesToLock);
      const existingLocks: { filePath: string; sessionId: string }[] = [];
      
      // Check each file path individually (less efficient but works with drizzle)
      for (const filePath of allFilePaths) {
        const lock = await tx.query.fileLocks.findFirst({
          where: (locks, { eq }) => eq(locks.filePath, filePath),
        });
        if (lock) {
          existingLocks.push({
            filePath: lock.filePath,
            sessionId: lock.sessionId,
          });
        }
      }

      // Acquire all locks
      await tx.insert(fileLocks).values(lockEntries);

      return {
        success: true,
        conflicts: [],
      };
    });

    if (!lockResult.success) {
      console.warn(
        `⚠️ Nexus: Batch dispatch blocked by ${lockResult.conflicts.length} file lock conflicts`,
      );
      return Response.json(
        {
          error: "File lock conflicts detected",
          conflicts: lockResult.conflicts,
          batchId,
          cascadeId,
        },
        { status: 409 },
      );
    }

    // Step 3: Create or get parent goal for cascade
    let cascadeGoalId = goalId;
    if (!cascadeGoalId) {
      const [cascadeGoal] = await db
        .insert(goals)
        .values({
          title: `Cascade Repair: ${cascadeId}`,
          description: `Automated cascade repair - batch ${batchId}`,
          acceptanceCriteria: jobs.map(job => ({
            text: job.prompt,
            met: false,
          })),
          status: "in-progress" as const,
        })
        .returning();

      cascadeGoalId = cascadeGoal.id;
    }

    // Step 4: Dispatch all Jules sessions in parallel
    const sessionPromises = jobs.map(async (job) => {
      try {
        const sessionPrompt = buildCascadeSessionPrompt(job, cascadeId);

        const session = await julesClient.createSession({
          prompt: sessionPrompt,
          sourceRepo,
          startingBranch: baseBranch,
          auditorContext: `cascade:${cascadeId};batch:${batchId};job:${job.id};files:${job.files.join(",")}`,
        });

        // Create session record in database
        await db.insert(sessions).values({
          id: `cascade_${cascadeId}_${job.id}`,
          goalId: cascadeGoalId,
          sourceRepo,
          branchName: baseBranch,
          baseBranch,
          status: "executing",
          externalSessionId: session.id,
          julesSessionUrl: session.url,
          lastError: null,
        });

        return {
          jobId: job.id,
          sessionId: session.id,
          sessionUrl: session.url,
          status: "dispatched",
          lockedFiles: job.files,
        };
      } catch (error) {
        console.error(`❌ Nexus: Failed to dispatch job ${job.id}:`, error);
        return {
          jobId: job.id,
          sessionId: "",
          sessionUrl: "",
          status: `failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          lockedFiles: job.files,
        };
      }
    });

    const sessionResults = await Promise.all(sessionPromises);

    const dispatchedCount = sessionResults.filter(s => s.status === "dispatched").length;
    const failedCount = sessionResults.filter(s => s.status.startsWith("failed")).length;

    console.log(
      `✅ Nexus: Batch dispatch ${batchId} complete - ${dispatchedCount}/${jobs.length} sessions started`,
    );

    return Response.json({
      batchId,
      cascadeId,
      totalJobs: jobs.length,
      dispatchedCount,
      failedCount,
      sessions: sessionResults,
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
