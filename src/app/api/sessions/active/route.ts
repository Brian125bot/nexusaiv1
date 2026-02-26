import { desc, inArray } from "drizzle-orm";

import { db } from "@/db";
import { sessions } from "@/db/schema";

const activeSessionStatuses = ["queued", "executing", "verifying"] as const;

export async function GET() {
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
