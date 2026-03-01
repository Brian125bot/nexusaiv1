import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import crypto from "crypto";

import { db } from "@/db";
import { goals, sessions, cascades, type AcceptanceCriterion } from "@/db/schema";
import { aiEnv } from "@/lib/config";
import { githubClient } from "@/lib/github/octokit";
import { analyzeCascade, type FileChange } from "@/lib/auditor/cascade-engine";
import { julesClient } from "@/lib/jules/client";
import { LockManager } from "@/lib/registry/lock-manager";

const google = createGoogleGenerativeAI({
  apiKey: aiEnv.GOOGLE_GENERATIVE_AI_API_KEY,
});

const AUDITOR_MODEL = "gemini-3-flash-preview";
const activeSessionStatuses = ["queued", "executing", "verifying"] as const;

const reviewSchema = z.object({
  severity: z.enum(["none", "minor", "major"]),
  summary: z.string().min(1),
  findings: z.array(z.string().min(1)).default([]),
  recommendedFixPrompt: z.string().min(1).optional(),
  criteriaAssessment: z.record(
    z.string(),
    z.object({
      met: z.boolean(),
      reasoning: z.string(),
      evidenceFiles: z.array(z.string()),
    })
  ).optional(),
});

export type ReviewInput = {
  eventType: "pull_request" | "push";
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
  severity?: z.infer<typeof reviewSchema>["severity"];
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
  severity: "none" | "minor" | "major";
  summary: string;
  findings: string[];
  recommendedFixPrompt?: string;
  goalId: string;
}): string {
  const lines: string[] = [
    "## Nexus Auditor Review",
    `Goal: ${input.goalId}`,
    `Severity: ${input.severity.toUpperCase()}`,
    "",
    input.summary,
  ];

  if (input.findings.length > 0) {
    lines.push("", "### Findings");
    for (const finding of input.findings) {
      lines.push(`- ${finding}`);
    }
  }

  if (input.severity === "major") {
    lines.push(
      "",
      "### Manual Action",
      "Major drift detected. Automatic Jules execution from webhook is disabled by policy.",
    );

    if (input.recommendedFixPrompt) {
      lines.push("Suggested Jules prompt:", "```text", input.recommendedFixPrompt, "```");
    }
  }

  return lines.join("\n");
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
    };
  }

  const goal = await db.query.goals.findFirst({ where: eq(goals.id, session.goalId) });

  if (!goal) {
    return {
      outcome: "missing_goal",
      sessionId: session.id,
      goalId: session.goalId,
    };
  }

  const diff =
    input.eventType === "pull_request" && input.prNumber
      ? await githubClient.getPullRequestDiff(input.owner, input.repo, input.prNumber)
      : await githubClient.getCommitDiff(input.owner, input.repo, input.sha);

  if (!diff.trim()) {
    return {
      outcome: "empty_diff_skipped",
      sessionId: session.id,
      goalId: goal.id,
    };
  }

  // Extract changed files from diff for cascade analysis
  const changedFiles = extractChangedFilesFromDiff(diff);
  const fileChanges: FileChange[] = changedFiles.map(filePath => ({
    filePath,
    diff: diff,
    status: "modified" as const,
  }));

  // Run cascade analysis in parallel with regular review
  const [reviewAnalysis, cascadeResult] = await Promise.all([
    generateObject({
      model: google(AUDITOR_MODEL),
      schema: reviewSchema,
      system:
        "You are the Nexus Auditor. Review this diff against the project's Acceptance Criteria. Identify any architectural drift, hardcoded secrets, or logic errors. Evaluate if each criterion in the provided list has been met based on the diff. In `criteriaAssessment`, provide an object mapped by criterion `id` containing `met`, `reasoning`, and `evidenceFiles` (paths of files proving the state).",
      prompt: [
        `Repository: ${sourceRepo}`,
        `Branch: ${input.branch}`,
        `Commit SHA: ${input.sha}`,
        "Acceptance Criteria:",
        JSON.stringify(goal.acceptanceCriteria ?? [], null, 2),
        "Git Diff:",
        diff,
      ].join("\n\n"),
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingLevel: "medium",
          },
        },
      },
    }),
    analyzeCascade(fileChanges),
  ]);

  const assessment = reviewAnalysis.object.criteriaAssessment;
  let hasFailure = false;

  // Update Goal Acceptance Criteria
  if (assessment && goal.acceptanceCriteria && Array.isArray(goal.acceptanceCriteria)) {
    const criteria = goal.acceptanceCriteria as AcceptanceCriterion[];
    const updatedCriteria = criteria.map((c) => {
      const result = assessment[c.id];
      if (result) {
        if (!result.met) hasFailure = true;
        return {
          ...c,
          met: result.met,
          reasoning: result.reasoning,
          files: result.evidenceFiles,
        };
      }
      return c;
    });

    await db.update(goals)
      .set({ acceptanceCriteria: updatedCriteria })
      .where(eq(goals.id, goal.id));
  } else if (reviewAnalysis.object.severity === "major") {
    hasFailure = true;
  }

  const comment = buildReviewComment({
    severity: reviewAnalysis.object.severity,
    summary: reviewAnalysis.object.summary,
    findings: reviewAnalysis.object.findings,
    recommendedFixPrompt: reviewAnalysis.object.recommendedFixPrompt,
    goalId: goal.id,
  });

  // Append cascade information to comment if detected
  const finalComment = cascadeResult.isCascade
    ? `${comment}\n\n---\n\n## 🌊 Blast Radius Cascade Detected\n\n**Core Files Changed:** ${cascadeResult.coreFilesChanged.join(", ")}\n\n**Downstream Files Affected:** ${cascadeResult.downstreamFiles.length}\n\n**Repair Jobs Identified:** ${cascadeResult.repairJobs.length}\n\n${cascadeResult.summary}\n\n> Cascade ID: \`${session.id}-cascade\``
    : comment;

  if (input.eventType === "pull_request" && input.prNumber) {
    await githubClient.postPullRequestComment(input.owner, input.repo, input.prNumber, finalComment);
  } else {
    await githubClient.postCommitComment(input.owner, input.repo, input.sha, finalComment);
  }

  if (cascadeResult.isCascade) {
    const cascadeId = `${session.id}-cascade`;
    await db.insert(cascades).values({
      id: cascadeId,
      triggerSessionId: session.id,
      coreFilesChanged: cascadeResult.coreFilesChanged,
      downstreamFiles: cascadeResult.downstreamFiles,
      repairJobCount: cascadeResult.repairJobs.length,
      summary: cascadeResult.summary,
      status: "analyzing",
    }).onConflictDoNothing();
  }

  let remediationTriggered = false;
  let newSessionId: string | undefined;

  if (hasFailure) {
    if (session.remediationDepth >= 3) {
      console.log(`🛑 Nexus: Maximum remediation depth reached for session ${session.id}. Marking goal as drifted.`);

      const manualInterventionMsg = "Maximum remediation depth reached. Manual intervention required.";

      // Append the manual intervention message to findings or summary
      await db.update(sessions)
        .set({
          status: "failed",
          lastError: manualInterventionMsg
        })
        .where(eq(sessions.id, session.id));

      await db.update(goals)
        .set({
          status: "drifted",
          description: goal.description ? `${goal.description}\n\n${manualInterventionMsg}` : manualInterventionMsg
        })
        .where(eq(goals.id, goal.id));
    } else {
      // Remediation Trigger: Dispatch a new "Fix-up" session
      newSessionId = `remediate-${crypto.randomUUID()}`;

      // Build a rich, context-aware prompt for the repair agent.
      const fixContext = reviewAnalysis.object.recommendedFixPrompt
        ? reviewAnalysis.object.recommendedFixPrompt
        : reviewAnalysis.object.findings.join("\n");

      const remediationPrompt = [
        `## Nexus Remediation Task`,
        ``,
        `**Remediation Depth:** ${session.remediationDepth + 1} / 3`,
        `**Parent Session:** ${session.id}`,
        `**Goal:** ${goal.id}`,
        `**Repository:** ${session.sourceRepo}`,
        `**Branch:** ${session.branchName}`,
        ``,
        `### Auditor Findings`,
        `**Severity:** ${reviewAnalysis.object.severity.toUpperCase()}`,
        `**Summary:** ${reviewAnalysis.object.summary}`,
        ``,
        `### Required Fix`,
        fixContext,
        ``,
        `### Constraints`,
        `- Work on the existing branch: \`${session.branchName}\``,
        `- Only modify files necessary to satisfy the above findings`,
        `- Do NOT introduce new dependencies unless absolutely required`,
        `- Ensure TypeScript compiles cleanly after your changes`,
        `- Commit with message: \`fix: nexus remediation [Nexus-Auto]\``,
      ].join("\n");

      console.log(`🛠️ Nexus: Remediation triggered for session ${session.id}. Depth: ${session.remediationDepth + 1}`);

      // Insert the queued session record and transfer locks atomically.
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

        // Atomic Handoff: Transfer file locks to the incoming repair session.
        await LockManager.transferLocks(session.id, newSessionId!, tx);
      });

      // DISPATCH: Eagerly kick off the Jules agent now rather than waiting
      // for a background poller that may never arrive.
      try {
        const julesSession = await julesClient.createSession({
          prompt: remediationPrompt,
          sourceRepo: session.sourceRepo,
          startingBranch: session.baseBranch ?? session.branchName,
          auditorContext: `remediation;parentSession:${session.id};depth:${session.remediationDepth + 1};goal:${goal.id}`,
        });

        // Persist the external ID so syncSessionStatus can poll Jules for progress.
        await db
          .update(sessions)
          .set({ status: "executing", externalSessionId: julesSession.id, julesSessionUrl: julesSession.url })
          .where(eq(sessions.id, newSessionId!));

        console.log(`🚀 Nexus: Jules remediation agent dispatched. External session: ${julesSession.id}`);
      } catch (dispatchErr) {
        // Dispatch failed — mark the new session as failed so it doesn't hang in queued state.
        const errMsg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
        console.error(`❌ Nexus: Failed to dispatch Jules remediation agent:`, dispatchErr);
        await db
          .update(sessions)
          .set({ status: "failed", lastError: `Jules dispatch failed: ${errMsg}`.substring(0, 5000) })
          .where(eq(sessions.id, newSessionId!));
      }

      remediationTriggered = true;
    }
  }

  if (!remediationTriggered && session.remediationDepth < 3) {
    await db
      .update(sessions)
      .set({
        lastReviewedCommit: input.sha,
        status: hasFailure ? "failed" : "completed",
      })
      .where(eq(sessions.id, session.id));
  } else if (remediationTriggered) {
    await db
      .update(sessions)
      .set({
        lastReviewedCommit: input.sha,
        status: "failed", // The current session failed, a new one was queued
      })
      .where(eq(sessions.id, session.id));
  }

  return {
    outcome: "review_posted",
    severity: reviewAnalysis.object.severity,
    sessionId: session.id,
    goalId: goal.id,
    commentTarget: input.eventType === "pull_request" ? "pull_request" : "commit",
    cascadeAnalysis: {
      isCascade: cascadeResult.isCascade,
      coreFilesChanged: cascadeResult.coreFilesChanged,
      repairJobCount: cascadeResult.repairJobs.length,
    },
    remediationTriggered,
    newSessionId,
  };
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
