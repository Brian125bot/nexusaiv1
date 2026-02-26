import { createSdk } from "@descope/nextjs-sdk/server";
import { authEnv } from "@/lib/config";

const sdk = createSdk({
  projectId: authEnv.DESCOPE_PROJECT_ID,
});

class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Extract and validate the Descope session from a request.
 * Returns the authenticated user's ID (sub claim).
 *
 * Throws if the session is invalid or missing.
 */
export async function getAuthenticatedUserId(req: Request): Promise<string> {
  const { userId } = await getValidatedIdentity(req);
  return userId;
}

export async function validateUser(req: Request): Promise<string> {
  const identity = await getValidatedIdentity(req);
  const allowedEmail = authEnv.ALLOWED_USER_EMAIL?.toLowerCase();

  const isAllowedUserId = identity.userId === authEnv.ALLOWED_USER_ID;
  const isAllowedEmail =
    Boolean(allowedEmail) && Boolean(identity.email) && identity.email?.toLowerCase() === allowedEmail;

  if (!isAllowedUserId && !isAllowedEmail) {
    throw new ForbiddenError("Forbidden: Identity mismatch");
  }

  return identity.userId;
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof ForbiddenError) {
    return Response.json({ error: error.message }, { status: 403 });
  }

  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function extractCookieValue(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1]?.trim() || undefined;
}

async function getValidatedIdentity(req: Request): Promise<{ userId: string; email?: string }> {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const token =
    authHeader.replace(/^Bearer\s+/i, "").trim() ||
    extractCookieValue(cookieHeader, "DS") ||
    extractCookieValue(cookieHeader, "DSR");

  if (!token) {
    throw new UnauthorizedError("No session token found");
  }

  const result = await sdk.validateJwt(token);
  const userId = result.token?.sub;

  if (!userId) {
    throw new UnauthorizedError("Invalid session token");
  }

  return {
    userId,
    email: typeof result.token?.email === "string" ? result.token.email : undefined,
  };
}
