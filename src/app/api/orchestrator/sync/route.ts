import { z } from "zod";

import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { syncSessionStatus } from "@/lib/jules/sync-service";
import { syncRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";

const syncRequestSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    externalSessionId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.sessionId || value.externalSessionId), {
    message: "sessionId or externalSessionId is required",
    path: ["sessionId"],
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

  const parsed = syncRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid sync request body",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const result = await syncSessionStatus(parsed.data);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync session";
    return Response.json({ error: message }, { status: 500 });
  }
}
