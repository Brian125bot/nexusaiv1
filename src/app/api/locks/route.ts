import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { fileLocks, sessions } from "@/db/schema";

export async function GET() {
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
