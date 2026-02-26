import { julesClient } from "@/lib/jules/client";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { apiRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";

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
    const sources = await julesClient.listSources();
    return Response.json({ sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list Jules sources";
    return Response.json({ error: message }, { status: 500 });
  }
}
