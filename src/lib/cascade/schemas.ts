import { z } from "zod";

export const cascadeRequestSchema = z.object({
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

export const cascadeResponseSchema = z.object({
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
  telemetry: z
    .object({
      dispatchLatencyMs: z.number().int().nonnegative(),
      conflictCount: z.number().int().nonnegative(),
      dispatchedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
    })
    .optional(),
});

export const batchDispatchSchema = z.object({
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

export const batchDispatchResponseSchema = z.object({
  batchId: z.string(),
  cascadeId: z.string(),
  totalJobs: z.number(),
  dispatchedCount: z.number(),
  failedCount: z.number(),
  sessions: z.array(
    z.object({
      jobId: z.string(),
      sessionId: z.string(),
      sessionUrl: z.string(),
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
  telemetry: z
    .object({
      dispatchLatencyMs: z.number().int().nonnegative(),
      conflictCount: z.number().int().nonnegative(),
      dispatchedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
    })
    .optional(),
});
