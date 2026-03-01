import { randomUUID } from "crypto";

import { generateText, stepCountIs, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { fileLocks, sessions } from "@/db/schema";
import { authErrorResponse, validateUser } from "@/lib/auth/session";
import { aiEnv } from "@/lib/config";
import { julesClient } from "@/lib/jules/client";
import { orchestratorRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";

const google = createGoogleGenerativeAI({
  apiKey: aiEnv.GOOGLE_GENERATIVE_AI_API_KEY,
});

const AUDITOR_MODEL = "gemini-3-flash-preview";

const requestSchema = z.object({
  goalId: z.string().uuid(),
  prompt: z.string().min(1),
  sourceRepo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "sourceRepo must be in owner/repo format"),
  startingBranch: z.string().min(1).default("main"),
});

const activeSessionStatuses = ["queued", "executing", "verifying"] as const;

type TriggerResult =
  | {
    ok: true;
    internalSessionId: string;
    externalSessionId: string;
    julesSessionUrl: string;
    branchName: string;
    baseBranch: string;
    message: string;
  }
  | {
    ok: false;
    reason: "lock_conflict";
    conflicts: unknown[];
    message: string;
  };

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await validateUser(req);
  } catch (error) {
    return authErrorResponse(error);
  }

  const { success, limit, remaining, reset } = await orchestratorRatelimit.limit(userId);
  if (!success) {
    return rateLimitExceededResponse({ limit, remaining, reset });
  }

  let requestBody: unknown;

  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid request body",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { goalId, prompt, sourceRepo, startingBranch } = parsed.data;

  try {
    const result = await generateText({
      model: google(AUDITOR_MODEL),
      system:
        "You are the Nexus Auditor, an AI technical lead. Your job is to review the user's coding request, check for active file locks in the database, and decide whether to start a new Jules coding session on main or stack it on an existing branch to avoid merge conflicts. Always check the database state before making a decision. Do not suggest or trigger a session until lock state is analyzed.\n\nIMPORTANT: When calling triggerJulesSession, you must pass the original user request EXACTLY as provided. Do NOT modify, paraphrase, or add any additional text to the prompt. The user's request must be sent to Jules unchanged.",
      prompt: [
        "Review this coding request and make an orchestration decision.",
        `goalId: ${goalId}`,
        `ORIGINAL_USER_REQUEST_START --> ${prompt} <-- ORIGINAL_USER_REQUEST_END`,
        `sourceRepo: ${sourceRepo}`,
        `startingBranch: ${startingBranch}`,
        "Step sequence is mandatory:",
        "1) call checkDatabaseState",
        "2) call triggerJulesSession - pass the original user request exactly as provided above (between the START and END markers)",
        "3) return concise reasoning and decision",
      ].join("\n"),
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingLevel: "medium",
          },
        },
      },
      stopWhen: stepCountIs(3),
      prepareStep: ({ stepNumber }) => {
        if (stepNumber === 0) {
          return {
            toolChoice: "required",
            activeTools: ["checkDatabaseState"],
          };
        }

        if (stepNumber === 1) {
          return {
            toolChoice: "required",
            activeTools: ["triggerJulesSession"],
          };
        }

        return {
          toolChoice: "none",
        };
      },
      tools: {
        checkDatabaseState: tool({
          description:
            "Query the Nexus registry and return all active sessions and current file locks.",
          inputSchema: z.object({}),
          execute: async () => {
            const activeSessions = await db
              .select()
              .from(sessions)
              .where(inArray(sessions.status, [...activeSessionStatuses]));

            const currentFileLocks = await db
              .select({
                id: fileLocks.id,
                sessionId: fileLocks.sessionId,
                filePath: fileLocks.filePath,
                lockedAt: fileLocks.lockedAt,
                sessionStatus: sessions.status,
                branchName: sessions.branchName,
                baseBranch: sessions.baseBranch,
                externalSessionId: sessions.externalSessionId,
              })
              .from(fileLocks)
              .innerJoin(sessions, eq(fileLocks.sessionId, sessions.id));

            const statusCounts = activeSessions.reduce<Record<string, number>>((acc, session) => {
              acc[session.status] = (acc[session.status] ?? 0) + 1;
              return acc;
            }, {});

            return {
              activeSessions,
              fileLocks: currentFileLocks,
              summary: {
                activeSessionCount: activeSessions.length,
                lockCount: currentFileLocks.length,
                statusCounts,
              },
            };
          },
        }),
        triggerJulesSession: tool({
          description:
            "Create a real Jules session and reserve file locks for the resulting coding task.",
          inputSchema: z.object({
            prompt: z.string().min(1),
            sourceRepo: z.string().min(1),
            startingBranch: z.string().min(1),
            impactFiles: z.array(z.string().min(1)).min(1),
          }),
          execute: async ({ prompt: toolPrompt, sourceRepo: toolSourceRepo, startingBranch: toolStartingBranch, impactFiles }): Promise<TriggerResult> => {
            const uniqueImpactFiles = [...new Set(impactFiles)];
            const internalSessionId = `nexus_${randomUUID()}`;
            const branchName = `nexus/${internalSessionId.slice(6, 14)}`;

            const conflictResult = await db.transaction(async (tx) => {
              const conflicts = await tx
                .select({
                  sessionId: fileLocks.sessionId,
                  filePath: fileLocks.filePath,
                  lockedAt: fileLocks.lockedAt,
                  sessionStatus: sessions.status,
                  branchName: sessions.branchName,
                  baseBranch: sessions.baseBranch,
                })
                .from(fileLocks)
                .innerJoin(sessions, eq(fileLocks.sessionId, sessions.id))
                .where(inArray(fileLocks.filePath, uniqueImpactFiles));

              if (conflicts.length > 0) {
                return {
                  ok: false as const,
                  reason: "lock_conflict" as const,
                  conflicts,
                  message:
                    "Session not queued because one or more impact files are already locked.",
                };
              }

              await tx.insert(sessions).values({
                id: internalSessionId,
                goalId,
                sourceRepo,
                branchName,
                baseBranch: startingBranch,
                status: "queued",
              });

              await tx.insert(fileLocks).values(
                uniqueImpactFiles.map((filePath) => ({
                  sessionId: internalSessionId,
                  filePath,
                })),
              );

              return null;
            });

            if (conflictResult) {
              return conflictResult;
            }

            try {
              const julesSession = await julesClient.createSession({
                prompt: toolPrompt,
                sourceRepo: toolSourceRepo,
                startingBranch: toolStartingBranch,
                auditorContext: `goalId=${goalId}; internalSessionId=${internalSessionId}; impactFiles=${uniqueImpactFiles.join(",")}`,
              });

              await db
                .update(sessions)
                .set({
                  externalSessionId: julesSession.id,
                  julesSessionUrl: julesSession.url,
                  status: "executing",
                  lastError: null,
                  lastSyncedAt: new Date(),
                })
                .where(eq(sessions.id, internalSessionId));

              return {
                ok: true,
                internalSessionId,
                externalSessionId: julesSession.id,
                julesSessionUrl: julesSession.url,
                branchName,
                baseBranch: startingBranch,
                message: `Jules session started from ${startingBranch}.`,
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "Failed to create Jules session";

              await db
                .update(sessions)
                .set({
                  status: "failed",
                  lastError: message,
                  lastSyncedAt: new Date(),
                })
                .where(eq(sessions.id, internalSessionId));

              await db
                .delete(fileLocks)
                .where(and(eq(fileLocks.sessionId, internalSessionId), inArray(fileLocks.filePath, uniqueImpactFiles)));

              throw new Error(`Jules trigger failed: ${message}`);
            }
          },
        }),
      },
      toolChoice: "required",
    });

    const allToolResults = result.steps.flatMap((step) => step.toolResults);

    const toolResultsByName = allToolResults.reduce<Record<string, unknown[]>>((acc, toolResult) => {
      if (!acc[toolResult.toolName]) {
        acc[toolResult.toolName] = [];
      }

      acc[toolResult.toolName].push(toolResult.output);
      return acc;
    }, {});

    const successfulTrigger = allToolResults
      .filter((toolResult) => toolResult.toolName === "triggerJulesSession")
      .map((toolResult) => toolResult.output as TriggerResult)
      .find((output) => output.ok);

    return Response.json({
      reasoning: result.text,
      toolResults: toolResultsByName,
      julesSessionId: successfulTrigger?.externalSessionId ?? null,
      julesSessionUrl: successfulTrigger?.julesSessionUrl ?? null,
      model: AUDITOR_MODEL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run orchestrator";

    return Response.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
