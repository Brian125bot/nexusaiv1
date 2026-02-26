import { randomUUID } from "crypto";

import { google } from "@ai-sdk/google";
import { stepCountIs, streamText, tool } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { fileLocks, sessions } from "@/db/schema";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { julesClient } from "@/lib/jules/client";
import { orchestratorRatelimit, rateLimitExceededResponse } from "@/lib/rate-limit";

const AUDITOR_MODEL = "gemini-3.0-flash-preview";

const requestSchema = z.object({
  goalId: z.string().uuid(),
  prompt: z.string().min(1),
  sourceRepo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "sourceRepo must be in owner/repo format"),
  startingBranch: z.string().min(1).default("main"),
  confirmDispatch: z.boolean().default(false),
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

type DraftPlanResult = {
  ok: true;
  mode: "draft";
  sourceRepo: string;
  startingBranch: string;
  impactFiles: string[];
  prompt: string;
};

function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await getAuthenticatedUserId(req);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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

  const { goalId, prompt, sourceRepo, startingBranch, confirmDispatch } = parsed.data;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      };

      void (async () => {
        const toolResultsByName: Record<string, unknown[]> = {};

        send("phase", {
          phase: "validation",
          status: "ok",
          confirmDispatch,
        });

        try {
          const result = streamText({
            model: google(AUDITOR_MODEL),
            system:
              "You are the Nexus Auditor, an AI technical lead. Review the coding request, inspect lock state, and produce a safe orchestration decision. Always check lock state before planning. If dispatch is disabled, produce a provisional plan only.",
            prompt: [
              "Review this coding request and make an orchestration decision.",
              `goalId: ${goalId}`,
              `request: ${prompt}`,
              `sourceRepo: ${sourceRepo}`,
              `startingBranch: ${startingBranch}`,
              `dispatchMode: ${confirmDispatch ? "confirm" : "draft"}`,
              "Step sequence is mandatory:",
              "1) call checkDatabaseState",
              confirmDispatch ? "2) call triggerJulesSession" : "2) call draftJulesPlan",
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
                  activeTools: [confirmDispatch ? "triggerJulesSession" : "draftJulesPlan"],
                };
              }

              return {
                toolChoice: "none",
              };
            },
            onStepFinish(step) {
              send("phase", {
                phase: "step_finish",
                stepNumber: step.stepNumber,
                finishReason: step.finishReason,
              });

              for (const toolResult of step.toolResults) {
                if (!toolResultsByName[toolResult.toolName]) {
                  toolResultsByName[toolResult.toolName] = [];
                }
                toolResultsByName[toolResult.toolName].push(toolResult.output);

                send("tool_result", {
                  toolName: toolResult.toolName,
                  output: toolResult.output,
                });
              }
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
              draftJulesPlan: tool({
                description:
                  "Draft a provisional plan of impact files and branch strategy without triggering Jules.",
                inputSchema: z.object({
                  prompt: z.string().min(1),
                  sourceRepo: z.string().min(1),
                  startingBranch: z.string().min(1),
                  impactFiles: z.array(z.string().min(1)).min(1),
                }),
                execute: async ({ prompt: toolPrompt, sourceRepo: toolSourceRepo, startingBranch: toolStartingBranch, impactFiles }): Promise<DraftPlanResult> => {
                  return {
                    ok: true,
                    mode: "draft",
                    prompt: toolPrompt,
                    sourceRepo: toolSourceRepo,
                    startingBranch: toolStartingBranch,
                    impactFiles: [...new Set(impactFiles)],
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
                    const message =
                      error instanceof Error ? error.message : "Failed to create Jules session";

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
                      .where(
                        and(
                          eq(fileLocks.sessionId, internalSessionId),
                          inArray(fileLocks.filePath, uniqueImpactFiles),
                        ),
                      );

                    throw new Error(`Jules trigger failed: ${message}`);
                  }
                },
              }),
            },
            toolChoice: "required",
          });

          send("phase", {
            phase: "reasoning",
            status: "streaming",
          });

          for await (const textDelta of result.textStream) {
            send("delta", { text: textDelta });
          }

          const [finalText, steps] = await Promise.all([result.text, result.steps]);
          const allToolResults = steps.flatMap((step) => step.toolResults);

          const successfulTrigger = allToolResults
            .filter((toolResult) => toolResult.toolName === "triggerJulesSession")
            .map((toolResult) => toolResult.output as TriggerResult)
            .find((output) => output.ok);

          const draftPlan = allToolResults
            .filter((toolResult) => toolResult.toolName === "draftJulesPlan")
            .map((toolResult) => toolResult.output as DraftPlanResult)
            .find((output) => output.ok);

          send("phase", {
            phase: "done",
            status: "ok",
          });

          send("final", {
            reasoning: finalText,
            toolResults: toolResultsByName,
            provisionalPlan: draftPlan ?? null,
            julesSessionId: successfulTrigger?.externalSessionId ?? null,
            julesSessionUrl: successfulTrigger?.julesSessionUrl ?? null,
            model: AUDITOR_MODEL,
            confirmDispatch,
          });

          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to stream orchestrator";
          send("error", { error: message });
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
