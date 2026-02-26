import { z } from "zod";

import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { syncSessionStatus } from "@/lib/jules/sync-service";
import { syncRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";

const syncBatchSchema = z
  .object({
    sessionIds: z.array(z.string().min(1)).optional(),
    externalSessionIds: z.array(z.string().min(1)).optional(),
  })
  .refine((value) => Boolean(value.sessionIds?.length || value.externalSessionIds?.length), {
    message: "sessionIds or externalSessionIds is required",
    path: ["sessionIds"],
  });

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { success, limit, remaining, reset } = await syncRatelimit.limit(userId);
  if (!success) {
    return rateLimitExceededResponse({ limit, remaining, reset });
  }

  let requestBody: unknown;

  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = syncBatchSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid sync batch request body",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const jobInputs = [
    ...(parsed.data.sessionIds ?? []).map((sessionId) => ({ sessionId })),
    ...(parsed.data.externalSessionIds ?? []).map((externalSessionId) => ({ externalSessionId })),
  ];

  const uniqueJobs = new Map<string, (typeof jobInputs)[number]>();
  for (const job of jobInputs) {
    const key =
      "sessionId" in job ? `session:${job.sessionId}` : `external:${job.externalSessionId}`;
    uniqueJobs.set(key, job);
  }

  const results = await Promise.all(
    [...uniqueJobs.values()].map(async (job) => {
      try {
        const result = await syncSessionStatus(job);
        return {
          ok: true,
          input: job,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to sync session";
        return {
          ok: false,
          input: job,
          error: message,
        };
      }
    }),
  );

  return Response.json({ results });
}
