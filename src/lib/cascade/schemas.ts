import { z } from "zod";

const initialCascadeSchema = z.object({
  type: z.literal("initial").optional().default("initial"),
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

const remediationCascadeSchema = z.object({
  type: z.literal("remediation"),
  sessionId: z.string().min(1),
  logs: z.string(),
});

export const cascadeRequestSchema = z.union([
  initialCascadeSchema,
  remediationCascadeSchema,
]);

export type CascadeRequest = z.infer<typeof cascadeRequestSchema>;

export const cascadeResponseSchema = z.object({
  cascadeId: z.string().optional(),
  isCascade: z.boolean().optional(),
  coreFilesChanged: z.array(z.string()).optional(),
  downstreamFiles: z.array(z.string()).optional(),
  repairJobs: z.array(
    z.object({
      id: z.string(),
      files: z.array(z.string()),
      prompt: z.string(),
      priority: z.enum(["high", "medium", "low"]),
      estimatedImpact: z.string(),
    }),
  ).optional(),
  dispatchedSessions: z
    .array(
      z.object({
        jobId: z.string().optional(),
        sessionId: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  summary: z.string().optional(),
  confidence: z.number().optional(),
  telemetry: z
    .object({
      dispatchLatencyMs: z.number().int().nonnegative(),
      conflictCount: z.number().int().nonnegative(),
      dispatchedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
    })
    .optional(),
  result: z.string().optional(), // For remediation responses
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
