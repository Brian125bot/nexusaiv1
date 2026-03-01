import { eq } from "drizzle-orm";

import { db } from "@/db";
import { sessions } from "@/db/schema";
import { LockManager } from "@/lib/registry/lock-manager";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Escape Hatch API: Terminate a session and release all its locks.
 * 
 * This endpoint forcibly terminates a session (sets status to 'failed')
 * and releases all file locks held by that session. It's designed to
 * handle orphaned locks when test runners crash or agents stall.
 */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!id) {
    return Response.json({ error: "Session ID is required" }, { status: 400 });
  }

  try {
    // Update session status to 'failed' with termination message
    const [updated] = await db
      .update(sessions)
      .set({ 
        status: "failed", 
        lastError: "Manually terminated by Admin/Test teardown" 
      })
      .where(eq(sessions.id, id))
      .returning({ id: sessions.id });

    // If no session was found, still attempt to release any orphaned locks
    // This makes the endpoint idempotent
    await LockManager.releaseLocks(id);

    return Response.json({ 
      success: true, 
      message: "Session terminated and locks released",
      sessionId: id 
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to terminate session";
    return Response.json({ error: message }, { status: 500 });
  }
}
