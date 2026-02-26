import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { sessions } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";

export const runtime = "nodejs";

const cascadeEventSchema = z.object({
  cascadeId: z.string(),
  isCascade: z.boolean(),
  coreFilesChanged: z.array(z.string()),
  downstreamFiles: z.array(z.string()),
  repairJobCount: z.number(),
  status: z.enum(["analyzing", "dispatched", "completed", "failed"]),
  createdAt: z.number(),
});

/**
 * GET /api/cascade/events
 * 
 * Retrieve recent cascade events
 */
export async function GET(req: Request) {
  try {
    await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  try {
    // Query sessions that have cascade metadata
    const cascadeSessions = await db.query.sessions.findMany({
      where: eq(sessions.lastError, "cascade"),
      orderBy: [desc(sessions.createdAt)],
      limit: 20,
    });

    // Parse cascade events from session metadata
    const cascades = cascadeSessions
      .filter((session) => session.lastError && session.lastError.startsWith('{"type":"cascade"'))
      .map((session) => {
        try {
          const cascadeData = JSON.parse(session.lastError || "{}");
          if (cascadeData.type !== "cascade") return null;

          return {
            cascadeId: session.id.replace(/_.*/, "_cascade"),
            isCascade: true,
            coreFilesChanged: cascadeData.data?.coreFilesChanged || [],
            downstreamFiles: cascadeData.data?.downstreamFiles || [],
            repairJobCount: cascadeData.data?.repairJobs?.length || 0,
            status: session.status === "executing" ? "dispatched" : session.status === "failed" ? "failed" : "completed",
            createdAt: session.createdAt.getTime(),
          };
        } catch {
          return null;
        }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // Deduplicate by cascadeId
    const uniqueCascades = Array.from(
      new Map(cascades.map((c) => [c.cascadeId, c])).values(),
    );

    return Response.json({
      cascades: uniqueCascades,
    });
  } catch (error) {
    console.error("Failed to fetch cascade events:", error);
    return Response.json(
      {
        error: "Failed to fetch cascade events",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
