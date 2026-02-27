import { desc } from "drizzle-orm";

import { db } from "@/db";
import { cascades } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";

export const runtime = "nodejs";

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
    const recentCascades = await db.query.cascades.findMany({
      orderBy: [desc(cascades.createdAt)],
      limit: 50,
    });

    const formattedCascades = recentCascades.map((cascade) => ({
      cascadeId: cascade.id,
      isCascade: true,
      coreFilesChanged: cascade.coreFilesChanged,
      downstreamFiles: cascade.downstreamFiles,
      repairJobCount: cascade.repairJobCount,
      status: cascade.status,
      createdAt: cascade.createdAt.getTime(),
    }));

    return Response.json({
      cascades: formattedCascades,
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
