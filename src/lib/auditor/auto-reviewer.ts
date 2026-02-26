import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { goals, sessions, cascades } from "@/db/schema";
import { aiEnv } from "@/lib/config";
import { githubClient } from "@/lib/github/octokit";
import { analyzeCascade, detectCoreFileChanges, type FileChange } from "@/lib/auditor/cascade-engine";

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
        "You are the Nexus Auditor. Review this diff against the project's Acceptance Criteria. Identify any architectural drift, hardcoded secrets, or logic errors.",
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

  await db
    .update(sessions)
    .set({ 
      lastReviewedCommit: input.sha,
    })
    .where(eq(sessions.id, session.id));

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
