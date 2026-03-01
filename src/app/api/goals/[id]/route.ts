import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { goals } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { rateLimitExceededResponse, writeRatelimit } from "@/lib/rate-limit";

const acceptanceCriterionSchema = z.union([
  z.string().trim().min(1),
  z.object({
    id: z.string().optional(),
    text: z.string().trim().min(1),
    met: z.boolean().optional().default(false),
    files: z.array(z.string()).optional(),
  }),
]);

const updateGoalSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().nullable().optional(),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).optional(),
    status: z.enum(["backlog", "in-progress", "completed", "drifted"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(req: Request, context: RouteContext) {
  let userId: string;
  try {
    userId = await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { success, limit, remaining, reset } = await writeRatelimit.limit(userId);
  if (!success) {
    return rateLimitExceededResponse({ limit, remaining, reset });
  }

  const { id } = await context.params;

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = updateGoalSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid goal payload",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  try {
    const { acceptanceCriteria, ...restPayload } = parsed.data;
    
    // Normalize acceptance criteria if provided
    const updateData = {
      ...restPayload,
      ...(acceptanceCriteria ? {
        acceptanceCriteria: acceptanceCriteria.map((criterion) => {
          if (typeof criterion === "string") {
            return {
              id: randomUUID(),
              text: criterion,
              met: false,
            };
          }
          return {
            id: criterion.id || randomUUID(),
            text: criterion.text,
            met: criterion.met,
            files: criterion.files,
          };
        })
      } : {})
    };

    const [updated] = await db.update(goals).set(updateData).where(eq(goals.id, id)).returning();

    if (!updated) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }

    return Response.json({ goal: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update goal";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: RouteContext) {
  let userId: string;
  try {
    userId = await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { success, limit, remaining, reset } = await writeRatelimit.limit(userId);
  if (!success) {
    return rateLimitExceededResponse({ limit, remaining, reset });
  }

  const { id } = await context.params;

  try {
    const [deleted] = await db.delete(goals).where(eq(goals.id, id)).returning({ id: goals.id });

    if (!deleted) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete goal";
    return Response.json({ error: message }, { status: 500 });
  }
}
