import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";

import { db } from "@/db";
import { goals, sessions, cascades, type AcceptanceCriterion } from "@/db/schema";
import { aiEnv } from "@/lib/config";
import { githubClient } from "@/lib/github/octokit";
import { analyzeCascade, detectCoreFileChanges, type FileChange } from "@/lib/auditor/cascade-engine";
import { findDownstreamDependents } from "@/lib/ast/dependency-graph";
import { julesClient } from "@/lib/jules/client";
import { LockManager } from "@/lib/registry/lock-manager";

const google = createGoogleGenerativeAI({
  apiKey: aiEnv.GOOGLE_GENERATIVE_AI_API_KEY,
});

const AUDITOR_MODEL = "gemini-3-flash-preview";
const activeSessionStatuses = ["queued", "executing", "verifying"] as const;

const semanticReviewSchema = z.object({
  decision: z.enum(["approve", "remediate", "reject"]),
  summary: z.string().min(1),
  findings: z.array(z.string().min(1)).default([]),
  remediationPrompt: z.string().min(1).optional(),
  criteriaAssessment: z
    .record(
      z.string(),
      z.object({
        met: z.boolean(),
        reasoning: z.string(),
        evidenceFiles: z.array(z.string()),
      }),
    )
    .optional(),
});

export type ReviewInput = {
  eventType: "pull_request" | "push";
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  prNumber?: number;
};

export type ReviewPrInput = {
  sessionId: string;
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  prNumber?: number;
};

export type ReviewResult = {
  outcome:
    | "review_posted"
    | "duplicate_commit_skipped"
    | "no_active_session"
    | "missing_goal"
    | "empty_diff_skipped";
  decision?: z.infer<typeof semanticReviewSchema>["decision"];
  sessionId?: string;
  goalId?: string;
  commentTarget?: "pull_request" | "commit";
  cascadeAnalysis?: {
    isCascade: boolean;
    coreFilesChanged: string[];
    repairJobCount: number;
  };
  remediationTriggered?: boolean;
  newSessionId?: string;
};

function buildReviewComment(input: {
  decision: "approve" | "remediate" | "reject";
  summary: string;
  findings: string[];
  remediationPrompt?: string;
  goalId: string;
}): string {
  const lines: string[] = [
    "## Nexus Auditor Review",
    `Goal: ${input.goalId}`,
    `Decision: ${input.decision.toUpperCase()}`,
    "",
    input.summary,
  ];

  if (input.findings.length > 0) {
    lines.push("", "### Findings");
    for (const finding of input.findings) {
      lines.push(`- ${finding}`);
    }
  }

  if (input.decision === "remediate" && input.remediationPrompt) {
    lines.push("", "### Remediation Prompt", "```text", input.remediationPrompt, "```");
  }

  if (input.decision === "reject") {
    lines.push("", "### Architectural Violation", "Changes rejected against Acceptance Criteria.");
  }

  return lines.join("\n");
}

function updateCriteriaAssessment(
  acceptanceCriteria: AcceptanceCriterion[],
  assessment: z.infer<typeof semanticReviewSchema>["criteriaAssessment"],
): { updated: AcceptanceCriterion[]; hasFailure: boolean } {
  let hasFailure = false;

  const updated = acceptanceCriteria.map((criterion) => {
    const result = assessment?.[criterion.id];
    if (!result) {
      return criterion;
    }

    if (!result.met) {
      hasFailure = true;
    }

    return {
      ...criterion,
      met: result.met,
      reasoning: result.reasoning,
      files: result.evidenceFiles,
    };
  });

  return { updated, hasFailure };
}

export async function reviewWebhookEvent(input: ReviewInput): Promise<ReviewResult> {
  const sourceRepo = `${input.owner}/${input.repo}`;

  const session = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.sourceRepo, sourceRepo),
      eq(sessions.branchName, input.branch),
      inArray(sessions.status, [...activeSessionStatuses]),
    ),
    orderBy: [desc(sessions.createdAt)],
  });

  if (!session) {
    return { outcome: "no_active_session" };
  }

  return reviewPr({
    sessionId: session.id,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    sha: input.sha,
    prNumber: input.prNumber,
  });
}

export async function reviewPr(input: ReviewPrInput): Promise<ReviewResult> {
  const sourceRepo = `${input.owner}/${input.repo}`;

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, input.sessionId),
  });

  if (!session) {
    return { outcome: "no_active_session" };
  }

  let locksTransferred = false;
  let remediationTriggered = false;
  let newSessionId: string | undefined;

  try {
    if (session.lastReviewedCommit && session.lastReviewedCommit === input.sha) {
      return {
        outcome: "duplicate_commit_skipped",
        sessionId: session.id,
        goalId: session.goalId ?? undefined,
      };
    }

    if (!session.goalId) {
      return {
        outcome: "missing_goal",
        sessionId: session.id,
        goalId: session.goalId ?? undefined,
      };
    }

    const goal = await db.query.goals.findFirst({
      where: eq(goals.id, session.goalId),
    });

    if (!goal) {
      return {
        outcome: "missing_goal",
        sessionId: session.id,
        goalId: session.goalId,
      };
    }

    const acceptanceCriteria = Array.isArray(goal.acceptanceCriteria)
      ? (goal.acceptanceCriteria as AcceptanceCriterion[])
      : [];

    const diff =
      input.prNumber !== undefined
        ? await githubClient.getPullRequestDiff(input.owner, input.repo, input.prNumber)
        : await githubClient.getCommitDiff(input.owner, input.repo, input.sha);

    if (!diff.trim()) {
      await db
        .update(sessions)
        .set({
          status: "completed",
          lastReviewedCommit: input.sha,
          lastSyncedAt: new Date(),
        })
        .where(eq(sessions.id, session.id));

      return {
        outcome: "empty_diff_skipped",
        sessionId: session.id,
        goalId: goal.id,
      };
    }

    const changedFiles = extractChangedFilesFromDiff(diff);
    const fileChanges: FileChange[] = changedFiles.map((filePath) => ({
      filePath,
      diff,
      status: "modified",
    }));
    const coreFilesChanged = detectCoreFileChanges(changedFiles);
    const astDownstreamFiles = coreFilesChanged.length > 0 ? await findDownstreamDependents(coreFilesChanged) : [];

    const [reviewAnalysis, cascadeResult] = await Promise.all([
      generateObject({
        model: google(AUDITOR_MODEL),
        schema: semanticReviewSchema,
        system:
          "You are the Nexus Semantic Auditor. Evaluate code changes strictly against the provided Acceptance Criteria. Return decision=approve only when criteria are satisfied and architecture is coherent. Return decision=remediate when fixes are feasible in-place. Return decision=reject when changes violate architecture or intent and should be blocked.",
        prompt: [
          `Repository: ${sourceRepo}`,
          `Branch: ${input.branch}`,
          `Commit SHA: ${input.sha}`,
          "Acceptance Criteria:",
          JSON.stringify(acceptanceCriteria, null, 2),
          "Git Diff:",
          diff,
          "Output instructions:",
          "- Set decision to one of: approve, remediate, reject",
          "- Provide criteriaAssessment keyed by criterion id with met/reasoning/evidenceFiles",
          "- Do not skip criteria; be explicit",
        ].join("\n\n"),
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingLevel: "medium",
            },
          },
        },
      }),
      analyzeCascade(fileChanges, astDownstreamFiles),
    ]);

    const assessment = reviewAnalysis.object.criteriaAssessment;
    const { updated: updatedCriteria, hasFailure } = updateCriteriaAssessment(acceptanceCriteria, assessment);

    await db
      .update(goals)
      .set({ acceptanceCriteria: updatedCriteria })
      .where(eq(goals.id, goal.id));

    const comment = buildReviewComment({
      decision: reviewAnalysis.object.decision,
      summary: reviewAnalysis.object.summary,
      findings: reviewAnalysis.object.findings,
      remediationPrompt: reviewAnalysis.object.remediationPrompt,
      goalId: goal.id,
    });

    const finalComment = cascadeResult.isCascade
      ? `${comment}\n\n---\n\n## Blast Radius Cascade Detected\n\n**Core Files Changed:** ${cascadeResult.coreFilesChanged.join(", ")}\n\n**Downstream Files Affected:** ${cascadeResult.downstreamFiles.length}\n\n**Repair Jobs Identified:** ${cascadeResult.repairJobs.length}\n\n${cascadeResult.summary}`
      : comment;

    const resolvedPrNumber = input.prNumber ?? (await githubClient.findOpenPullRequestNumber(input.owner, input.repo, input.branch));

    if (resolvedPrNumber !== null) {
      await githubClient.postPullRequestComment(input.owner, input.repo, resolvedPrNumber, finalComment);
    } else {
      await githubClient.postCommitComment(input.owner, input.repo, input.sha, finalComment);
    }

    if (cascadeResult.isCascade) {
      const cascadeId = `${session.id}-cascade`;
      await db
        .insert(cascades)
        .values({
          id: cascadeId,
          triggerSessionId: session.id,
          coreFilesChanged: cascadeResult.coreFilesChanged,
          downstreamFiles: cascadeResult.downstreamFiles,
          repairJobCount: cascadeResult.repairJobs.length,
          summary: cascadeResult.summary,
          status: "analyzing",
          isAstVerified: true,
        })
        .onConflictDoNothing();
    }

    const decision = reviewAnalysis.object.decision;
    const effectiveDecision = hasFailure && decision === "approve" ? "remediate" : decision;

    if (effectiveDecision === "approve") {
      if (resolvedPrNumber === null) {
        throw new Error("Semantic approval requires an open pull request for merge");
      }

      await githubClient.mergePullRequest(input.owner, input.repo, resolvedPrNumber, "squash");

      await db.transaction(async (tx) => {
        await tx
          .update(goals)
          .set({ status: "completed", acceptanceCriteria: updatedCriteria })
          .where(eq(goals.id, goal.id));

        await tx
          .update(sessions)
          .set({
            status: "completed",
            lastReviewedCommit: input.sha,
            lastSyncedAt: new Date(),
            lastError: null,
          })
          .where(eq(sessions.id, session.id));
      });

      return {
        outcome: "review_posted",
        decision: effectiveDecision,
        sessionId: session.id,
        goalId: goal.id,
        commentTarget: resolvedPrNumber !== null ? "pull_request" : "commit",
        cascadeAnalysis: {
          isCascade: cascadeResult.isCascade,
          coreFilesChanged: cascadeResult.coreFilesChanged,
          repairJobCount: cascadeResult.repairJobs.length,
        },
        remediationTriggered,
      };
    }

    if (effectiveDecision === "remediate") {
      if (session.remediationDepth >= 3) {
        const manualInterventionMsg = "Maximum remediation depth reached. Manual intervention required.";

        await db.transaction(async (tx) => {
          await tx
            .update(sessions)
            .set({
              status: "failed",
              lastReviewedCommit: input.sha,
              lastError: manualInterventionMsg,
            })
            .where(eq(sessions.id, session.id));

          await tx
            .update(goals)
            .set({
              status: "drifted",
              description: goal.description ? `${goal.description}\n\n${manualInterventionMsg}` : manualInterventionMsg,
            })
            .where(eq(goals.id, goal.id));
        });

        return {
          outcome: "review_posted",
          decision: "reject",
          sessionId: session.id,
          goalId: goal.id,
          commentTarget: resolvedPrNumber !== null ? "pull_request" : "commit",
          cascadeAnalysis: {
            isCascade: cascadeResult.isCascade,
            coreFilesChanged: cascadeResult.coreFilesChanged,
            repairJobCount: cascadeResult.repairJobs.length,
          },
          remediationTriggered: false,
        };
      }

      newSessionId = `remediate-${crypto.randomUUID()}`;

      const fixContext = reviewAnalysis.object.remediationPrompt
        ? reviewAnalysis.object.remediationPrompt
        : reviewAnalysis.object.findings.join("\n");

      const remediationPrompt = [
        "## Nexus Semantic Remediation Task",
        "",
        `**Remediation Depth:** ${session.remediationDepth + 1} / 3`,
        `**Parent Session:** ${session.id}`,
        `**Goal:** ${goal.id}`,
        `**Repository:** ${session.sourceRepo}`,
        `**Branch:** ${session.branchName}`,
        "",
        "### Acceptance Criteria",
        ...updatedCriteria.map((criterion) => `- [${criterion.met ? "x" : " "}] ${criterion.text}`),
        "",
        "### Auditor Summary",
        reviewAnalysis.object.summary,
        "",
        "### Required Fix",
        fixContext,
        "",
        "### Constraints",
        `- Work on the existing branch: \`${session.branchName}\``,
        "- Only modify files necessary to satisfy the findings",
        "- Do NOT introduce new dependencies unless absolutely required",
        "- Ensure TypeScript compiles cleanly after your changes",
        "- Commit with message: `fix: semantic remediation [Nexus-Auto]`",
      ].join("\n");

      await db.transaction(async (tx) => {
        await tx.insert(sessions).values({
          id: newSessionId!,
          goalId: goal.id,
          sourceRepo: session.sourceRepo,
          branchName: session.branchName,
          baseBranch: session.baseBranch,
          status: "queued",
          remediationDepth: session.remediationDepth + 1,
        });

        await LockManager.transferLocks(session.id, newSessionId!, tx);
        locksTransferred = true;

        await tx
          .update(sessions)
          .set({
            status: "failed",
            lastReviewedCommit: input.sha,
            lastError: "Semantic remediation dispatched to child session",
          })
          .where(eq(sessions.id, session.id));
      });

      try {
        const julesSession = await julesClient.createSession({
          prompt: remediationPrompt,
          sourceRepo: session.sourceRepo,
          startingBranch: session.baseBranch ?? session.branchName,
        });

        await db
          .update(sessions)
          .set({ status: "executing", externalSessionId: julesSession.id, julesSessionUrl: julesSession.url })
          .where(eq(sessions.id, newSessionId!));
      } catch (dispatchErr) {
        const errMsg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
        await db
          .update(sessions)
          .set({ status: "failed", lastError: `Jules dispatch failed: ${errMsg}`.substring(0, 5000) })
          .where(eq(sessions.id, newSessionId!));

        await LockManager.releaseLocks(newSessionId!);
      }

      remediationTriggered = true;

      return {
        outcome: "review_posted",
        decision: effectiveDecision,
        sessionId: session.id,
        goalId: goal.id,
        commentTarget: resolvedPrNumber !== null ? "pull_request" : "commit",
        cascadeAnalysis: {
          isCascade: cascadeResult.isCascade,
          coreFilesChanged: cascadeResult.coreFilesChanged,
          repairJobCount: cascadeResult.repairJobs.length,
        },
        remediationTriggered,
        newSessionId,
      };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({
          status: "failed",
          lastReviewedCommit: input.sha,
          lastError: `Semantic audit reject: ${reviewAnalysis.object.summary}`.substring(0, 5000),
        })
        .where(eq(sessions.id, session.id));

      await tx.update(goals).set({ status: "drifted" }).where(eq(goals.id, goal.id));
    });

    return {
      outcome: "review_posted",
      decision: effectiveDecision,
      sessionId: session.id,
      goalId: goal.id,
      commentTarget: resolvedPrNumber !== null ? "pull_request" : "commit",
      cascadeAnalysis: {
        isCascade: cascadeResult.isCascade,
        coreFilesChanged: cascadeResult.coreFilesChanged,
        repairJobCount: cascadeResult.repairJobs.length,
      },
      remediationTriggered,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await db
      .update(sessions)
      .set({
        status: "failed",
        lastError: `Semantic auditor failure: ${message}`.substring(0, 5000),
        lastReviewedCommit: input.sha,
      })
      .where(eq(sessions.id, session.id));

    throw error;
  } finally {
    if (!locksTransferred) {
      try {
        await LockManager.releaseLocks(session.id);
      } catch (releaseError) {
        console.error("Failed to release locks after reviewPr", releaseError);
      }
    }
  }
}

/**
 * Extract file paths from a git diff
 */
function extractChangedFilesFromDiff(diff: string): string[] {
  const filePattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const files = new Set<string>();
  let match;

  while ((match = filePattern.exec(diff)) !== null) {
    files.add(match[2]);
  }

  return Array.from(files);
}
