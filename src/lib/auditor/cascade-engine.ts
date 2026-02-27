import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

import { aiEnv } from "@/lib/config";
import { CASCADE_CONFIG, isCoreFile } from "@/lib/cascade-config";
import { julesClient } from "@/lib/jules/client";

const google = createGoogleGenerativeAI({
  apiKey: aiEnv.GOOGLE_GENERATIVE_AI_API_KEY,
});

const AUDITOR_MODEL = "gemini-3-flash-preview";

/**
 * Represents a file change in the commit
 */
export type FileChange = {
  filePath: string;
  diff: string;
  status: "added" | "modified" | "removed";
};

/**
 * A repair job identified by the cascade analysis
 */
export type CascadeRepairJob = {
  id: string;
  files: string[];
  prompt: string;
  priority: "high" | "medium" | "low";
  estimatedImpact: string;
};

/**
 * Result of cascade analysis
 */
export type CascadeAnalysisResult = {
  isCascade: boolean;
  coreFilesChanged: string[];
  downstreamFiles: string[];
  repairJobs: CascadeRepairJob[];
  summary: string;
  confidence: number;
};

/**
 * Schema for Gemini's cascade analysis output
 */
const cascadeAnalysisSchema = z.object({
  isCascade: z.boolean(),
  coreFilesChanged: z.array(z.string().min(1)),
  downstreamFiles: z.array(z.string().min(1)),
  repairJobs: z.array(
    z.object({
      id: z.string().min(1),
      files: z.array(z.string().min(1)).min(1),
      prompt: z.string().min(1),
      priority: z.enum(["high", "medium", "low"]),
      estimatedImpact: z.string().min(1),
    }),
  ),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

/**
 * Build the cascade analysis prompt for Gemini
 */
function buildCascadePrompt(
  coreFileChanges: FileChange[],
  allChangedFiles: string[],
): string {
  const sections: string[] = [
    "You are the Nexus Lead Architect. A core system file has been modified.",
    "Your task is to analyze the blast radius and decompose the repair work into discrete jobs.",
    "",
    "### Core File Changes",
  ];

  for (const change of coreFileChanges) {
    sections.push(`\n**File:** ${change.filePath}`);
    sections.push(`**Status:** ${change.status}`);
    sections.push("```diff");
    sections.push(change.diff);
    sections.push("```");
  }

  sections.push("");
  sections.push("### All Changed Files in Commit");
  sections.push(allChangedFiles.map(f => `- ${f}`).join("\n"));

  sections.push("");
  sections.push("### Instructions");
  sections.push("1. Identify which files in 'All Changed Files' import or depend on the core files");
  sections.push("2. Group these downstream files into logical 'Repair Jobs'");
  sections.push("3. Each Repair Job should be handleable by a separate AI agent");
  sections.push("4. Ensure NO file appears in multiple repair jobs");
  sections.push("5. For each job, provide a clear prompt describing what needs to be fixed");
  sections.push("");
  sections.push("### Output Requirements");
  sections.push("- isCascade: true if this change impacts multiple downstream files");
  sections.push("- coreFilesChanged: list of core files that were modified");
  sections.push("- downstreamFiles: all files that need updates due to this change");
  sections.push("- repairJobs: array of discrete repair tasks (3-5 jobs ideal)");
  sections.push("- summary: brief explanation of the architectural change");
  sections.push("- confidence: your confidence in this analysis (0-1)");

  return sections.join("\n");
}

/**
 * Analyze the blast radius of a core file change
 */
export async function analyzeCascade(
  allChangedFiles: FileChange[],
): Promise<CascadeAnalysisResult> {
  // Identify which changed files are core files
  const coreFileChanges = allChangedFiles.filter(change =>
    isCoreFile(change.filePath),
  );

  if (coreFileChanges.length === 0) {
    return {
      isCascade: false,
      coreFilesChanged: [],
      downstreamFiles: [],
      repairJobs: [],
      summary: "No core files changed - cascade analysis not required",
      confidence: 1,
    };
  }

  const allFilePaths = allChangedFiles.map(f => f.filePath);

  try {
    const { object: analysis } = await generateObject({
      model: google(AUDITOR_MODEL),
      schema: cascadeAnalysisSchema,
      system:
        "You are the Nexus Lead Architect AI. Analyze code changes for blast radius impact. Be conservative - only flag true cascade scenarios.",
      prompt: buildCascadePrompt(coreFileChanges, allFilePaths),
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingLevel: "high",
          },
        },
      },
    });

    // Filter repair jobs by confidence and max parallel agents
    const qualifiedJobs = analysis.repairJobs
      .filter(() => analysis.confidence >= CASCADE_CONFIG.minConfidenceScore)
      .slice(0, CASCADE_CONFIG.maxParallelAgents);

    return {
      ...analysis,
      repairJobs: qualifiedJobs,
    };
  } catch (error) {
    console.error("Cascade analysis failed:", error);
    return {
      isCascade: false,
      coreFilesChanged: coreFileChanges.map(f => f.filePath),
      downstreamFiles: [],
      repairJobs: [],
      summary: `Cascade analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      confidence: 0,
    };
  }
}

/**
 * Dispatch multiple Jules sessions for parallel repair
 */
export async function dispatchCascadeRepairs(
  sourceRepo: string,
  baseBranch: string,
  cascadeId: string,
  repairJobs: CascadeRepairJob[],
): Promise<Array<{ jobId: string; sessionId: string; status: string }>> {
  const results: Array<{ jobId: string; sessionId: string; status: string }> = [];

  // Create all sessions in parallel
  const sessionPromises = repairJobs.map(async (job) => {
    try {
      const sessionPrompt = [
        `## Cascade Repair Task`,
        ``,
        `**Cascade ID:** ${cascadeId}`,
        `**Priority:** ${job.priority.toUpperCase()}`,
        `**Impact:** ${job.estimatedImpact}`,
        ``,
        `### Files to Repair`,
        ...job.files.map(f => `- ${f}`),
        ``,
        `### Repair Instructions`,
        job.prompt,
        ``,
        `### Constraints`,
        `- Only modify the files listed above`,
        `- Ensure all imports and type references are updated correctly`,
        `- Run tests if available`,
        `- Create a single PR with all changes`,
      ].join("\n");

      const session = await julesClient.createSession({
        prompt: sessionPrompt,
        sourceRepo,
        startingBranch: baseBranch,
        auditorContext: `cascade:${cascadeId};job:${job.id};files:${job.files.join(",")}`,
      });

      results.push({
        jobId: job.id,
        sessionId: session.id,
        status: "dispatched",
      });

      console.log(`🚀 Nexus: Dispatched cascade repair job ${job.id} → Session ${session.id}`);
    } catch (error) {
      console.error(`❌ Nexus: Failed to dispatch job ${job.id}:`, error);
      results.push({
        jobId: job.id,
        sessionId: "",
        status: `failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  });

  await Promise.all(sessionPromises);
  return results;
}

/**
 * Check if a file path matches any core file pattern
 */
export function detectCoreFileChanges(filePaths: string[]): string[] {
  return filePaths.filter(isCoreFile);
}
