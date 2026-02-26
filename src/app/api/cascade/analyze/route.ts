import { z } from "zod";

import { db } from "@/db";
import { sessions, fileLocks, goals } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import {
  analyzeCascade,
  dispatchCascadeRepairs,
  type FileChange,
} from "@/lib/auditor/cascade-engine";
import { julesClient } from "@/lib/jules/client";

export const runtime = "nodejs";

const cascadeRequestSchema = z.object({
  sourceRepo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string().min(1),
  commitSha: z.string().min(1),
  fileChanges: z.array(
    z.object({
      filePath: z.string().min(1),
      diff: z.string().min(1),
      status: z.enum(["added", "modified", "removed"]),
    }),
  ),
  goalId: z.string().uuid().optional(),
  autoDispatch: z.boolean().default(false),
});

const cascadeResponseSchema = z.object({
  cascadeId: z.string(),
  isCascade: z.boolean(),
  coreFilesChanged: z.array(z.string()),
  downstreamFiles: z.array(z.string()),
  repairJobs: z.array(
    z.object({
      id: z.string(),
      files: z.array(z.string()),
      prompt: z.string(),
      priority: z.enum(["high", "medium", "low"]),
      estimatedImpact: z.string(),
    }),
  ),
  dispatchedSessions: z
    .array(
      z.object({
        jobId: z.string(),
        sessionId: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  summary: z.string(),
  confidence: z.number(),
});

export type CascadeDispatchResult = z.infer<typeof cascadeResponseSchema>;

/**
 * POST /api/cascade/analyze
 * 
 * Analyze the blast radius of core file changes and optionally dispatch repair agents
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await validateUser(req);
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
                text: job.prompt,
                met: false,
                files: job.files,
              })),
              status: "in-progress" as const,
            })
            .returning();

          return goalResult;
        });

        cascadeGoalId = cascadeGoal.id;
      }

      // Acquire locks for all files in the blast radius
      const allFilesToLock = analysis.downstreamFiles.flatMap(filePath => {
        const internalSessionId = `cascade_${cascadeId}_${filePath.replace(/\//g, "_")}`;
        return {
          sessionId: internalSessionId,
          filePath,
        };
      });

      // Try to acquire all locks atomically
      const lockResult = await db.transaction(async (tx) => {
        // Check for existing locks - use array filtering since drizzle doesn't support .in() on text columns
        const allFilePaths = allFilesToLock.map(l => l.filePath);
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

        if (existingLocks.length > 0) {
          return {
            success: false,
            conflicts: existingLocks,
          };
        }

        // Acquire all locks
        await tx.insert(fileLocks).values(allFilesToLock);

        return {
          success: true,
          conflicts: [],
        };
      });

      if (!lockResult.success) {
        console.warn(
          `⚠️ Nexus: Cascade dispatch blocked by ${lockResult.conflicts.length} file lock conflicts`,
        );
        return Response.json(
          {
            error: "File lock conflicts detected",
            conflicts: lockResult.conflicts,
            cascadeId,
            isCascade: true,
          },
          { status: 409 },
        );
      }

      // Dispatch all repair sessions in parallel
      dispatchedSessions = await dispatchCascadeRepairs(
        sourceRepo,
        branch,
        cascadeId,
        analysis.repairJobs,
      );

      // Create session records in database
      await Promise.all(
        dispatchedSessions.map(async (sessionResult) => {
          const job = analysis.repairJobs.find(j => j.id === sessionResult.jobId);
          if (!job) return;

          await db.insert(sessions).values({
            id: `cascade_${cascadeId}_${job.id}`,
            goalId: cascadeGoalId,
            sourceRepo,
            branchName: branch,
            baseBranch: branch,
            status: sessionResult.status === "dispatched" ? "executing" : "failed",
            externalSessionId: sessionResult.sessionId || undefined,
            lastError: sessionResult.status.startsWith("failed") ? sessionResult.status : null,
          });
        }),
      );

      console.log(
        `✅ Nexus: Cascade dispatch complete - ${dispatchedSessions.filter(s => s.status === "dispatched").length}/${dispatchedSessions.length} sessions started`,
      );
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
