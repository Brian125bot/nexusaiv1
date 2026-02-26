import { createSdk } from "@descope/nextjs-sdk/server";

const sdk = createSdk({
    projectId: process.env.DESCOPE_PROJECT_ID!,
});

/**
 * Extract and validate the Descope session from a request.
 * Returns the authenticated user's ID (sub claim).
 *
 * Throws if the session is invalid or missing.
 */
export async function getAuthenticatedUserId(req: Request): Promise<string> {
    // The Descope middleware sets a session cookie, but it also
    // forwards the session token as a Bearer header for API calls.
    const cookieHeader = req.headers.get("cookie") ?? "";
    const authHeader = req.headers.get("authorization") ?? "";

    // Try Bearer token first (programmatic clients), then fall back to cookie
    const token =
        authHeader.replace(/^Bearer\s+/i, "").trim() ||
        extractCookieValue(cookieHeader, "DS") ||
        extractCookieValue(cookieHeader, "DSR");

    if (!token) {
        throw new Error("No session token found");
    }

    const result = await sdk.validateJwt(token);

    if (!result.token?.sub) {
        throw new Error("Invalid session token");
    }

    return result.token.sub;
}

function extractCookieValue(cookieHeader: string, name: string): string | undefined {
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match?.[1]?.trim() || undefined;
}
