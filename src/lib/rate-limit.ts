import { kv } from "@vercel/kv";
import { Ratelimit } from "@upstash/ratelimit";

/**
 * Rate limiter for orchestrator endpoints (POST /api/orchestrator, /api/orchestrator/stream).
 * These endpoints call Gemini and Jules API, incurring real costs.
 * Limit: 5 requests per 60-second sliding window per user.
 */
export const orchestratorRatelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(5, "60 s"),
    prefix: "nexus:rl:orchestrator",
});

/**
 * Rate limiter for sync/polling endpoints (POST /api/orchestrator/sync, sync-batch).
 * More lenient since these are used for dashboard polling.
 * Limit: 30 requests per 60-second sliding window per user.
 */
export const syncRatelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(30, "60 s"),
    prefix: "nexus:rl:sync",
});

/**
 * General API limiter for lower-cost read endpoints.
 * Limit: 60 requests per 60-second sliding window per user.
 */
export const apiRatelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(60, "60 s"),
    prefix: "nexus:rl:api",
});

/**
 * Write-heavy limiter for mutation endpoints.
 * Limit: 10 requests per 60-second sliding window per user.
 */
export const writeRatelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(10, "60 s"),
    prefix: "nexus:rl:write",
});

/**
 * Helper to build a 429 response with standard rate-limit headers.
 */
export function rateLimitExceededResponse(result: {
    limit: number;
    remaining: number;
    reset: number;
}): Response {
    return Response.json(
        { error: "Rate limit exceeded. Try again later." },
        {
            status: 429,
            headers: {
                "X-RateLimit-Limit": String(result.limit),
                "X-RateLimit-Remaining": String(result.remaining),
                "X-RateLimit-Reset": String(result.reset),
                "Retry-After": String(Math.ceil((result.reset - Date.now()) / 1000)),
            },
        },
    );
}
