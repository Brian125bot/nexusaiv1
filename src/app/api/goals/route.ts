import { randomUUID } from "crypto";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { goals } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { apiRatelimit, rateLimitExceededResponse, writeRatelimit } from "@/lib/rate-limit";

const acceptanceCriterionSchema = z.union([
  z.string().trim().min(1),
  z.object({
    id: z.string().optional(),
    text: z.string().trim().min(1),
    met: z.boolean().optional().default(false),
    reasoning: z.string().nullable().optional(),
    files: z.array(z.string()).optional(),
  }),
]);

const createGoalSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  status: z.enum(["backlog", "in-progress", "completed", "drifted"]).optional(),
});

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
    const data = await db.select().from(goals).orderBy(desc(goals.createdAt));
    return Response.json({ goals: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch goals";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
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

  let requestBody: unknown;

  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createGoalSchema.safeParse(requestBody);
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
    const payload = parsed.data;
    
    const normalizedCriteria = payload.acceptanceCriteria.map((criterion) => {
      if (typeof criterion === "string") {
        return {
          id: randomUUID(),
          text: criterion,
          met: false,
          reasoning: null,
        };
      }
      return {
        id: criterion.id || randomUUID(),
        text: criterion.text,
        met: criterion.met,
        reasoning: criterion.reasoning || null,
        files: criterion.files,
      };
    });

    const [created] = await db
      .insert(goals)
      .values({
        title: payload.title,
        description: payload.description,
        acceptanceCriteria: normalizedCriteria,
        status: payload.status ?? "backlog",
      })
      .returning();

    return Response.json({ goal: created }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create goal";
    return Response.json({ error: message }, { status: 500 });
  }
}
