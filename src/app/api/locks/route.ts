import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { fileLocks, sessions } from "@/db/schema";
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
    const locks = await db
      .select({
        id: fileLocks.id,
        filePath: fileLocks.filePath,
        lockedAt: fileLocks.lockedAt,
        sessionId: fileLocks.sessionId,
        branchName: sessions.branchName,
        baseBranch: sessions.baseBranch,
        julesSessionUrl: sessions.julesSessionUrl,
        externalSessionId: sessions.externalSessionId,
        goalId: sessions.goalId,
        status: sessions.status,
      })
      .from(fileLocks)
      .innerJoin(sessions, eq(fileLocks.sessionId, sessions.id))
      .orderBy(desc(fileLocks.lockedAt));

    return Response.json({ locks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch locks";
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/locks
 * 
 * Release file locks. Provide either filePath or sessionId to release locks.
 */
export async function DELETE(req: Request) {
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
    const url = new URL(req.url);
    const filePath = url.searchParams.get("filePath");
    const sessionId = url.searchParams.get("sessionId");

    if (!filePath && !sessionId) {
      return Response.json(
        { error: "Either filePath or sessionId query parameter is required" },
        { status: 400 }
      );
    }

    let deletedRecords;
    
    if (filePath) {
      deletedRecords = await db
        .delete(fileLocks)
        .where(eq(fileLocks.filePath, filePath))
        .returning();
    } else if (sessionId) {
      deletedRecords = await db
        .delete(fileLocks)
        .where(eq(fileLocks.sessionId, sessionId))
        .returning();
    } else {
      deletedRecords = [];
    }

    console.log(`🔓 Nexus: Released ${deletedRecords.length} lock(s)`);

    return Response.json({
      success: true,
      releasedCount: deletedRecords.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to release lock";
    return Response.json({ error: message }, { status: 500 });
  }
}
