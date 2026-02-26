import { z } from "zod";

import { syncSessionStatus } from "@/lib/jules/sync-service";

const syncRequestSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    externalSessionId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.sessionId || value.externalSessionId), {
    message: "sessionId or externalSessionId is required",
    path: ["sessionId"],
  });

export async function POST(req: Request) {
  let requestBody: unknown;

  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = syncRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid sync request body",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const result = await syncSessionStatus(parsed.data);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync session";
    return Response.json({ error: message }, { status: 500 });
  }
}
