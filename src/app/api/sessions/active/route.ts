import { desc, inArray } from "drizzle-orm";

import { db } from "@/db";
import { sessions } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { apiRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";

const activeSessionStatuses = ["queued", "executing", "verifying"] as const;

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { success, limit, remaining, reset } = await apiRatelimit.limit(userId);
  if (!success) {
    return rateLimitExceededResponse({ limit, remaining, reset });
  }

  try {
    const active = await db
      .select()
      .from(sessions)
      .where(inArray(sessions.status, [...activeSessionStatuses]))
      .orderBy(desc(sessions.createdAt));

    return Response.json({ sessions: active });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch active sessions";
    return Response.json({ error: message }, { status: 500 });
  }
}
