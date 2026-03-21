import { db } from "@/db";
import { goals } from "@/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs/promises";
import path from "path";
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { aiEnv } from "@/lib/config";

const google = createGoogleGenerativeAI({
  apiKey: aiEnv.GOOGLE_GENERATIVE_AI_API_KEY,
});

const model = google("gemini-3-flash-preview");

export async function buildEnrichedPrompt(basePrompt: string, goalId?: string, impactFiles?: string[]): Promise<string> {
  if (!goalId) {
    return basePrompt;
  }

  const goal = await db.query.goals.findFirst({
    where: eq(goals.id, goalId),
  });

  if (!goal) {
    return basePrompt;
  }

  const formattedCriteria = goal.acceptanceCriteria.map(ac => `- [ ] ${ac.text}`).join('\n');
  const formattedImpactFiles = impactFiles && impactFiles.length > 0
    ? impactFiles.join(', ')
    : 'None specified';

  const fallbackPrompt = `${basePrompt}

=========================================
🛡️ NEXUS ARCHITECTURAL CONTEXT
=========================================
**Goal:** ${goal.title}
**Description:** ${goal.description || 'N/A'}

**Acceptance Criteria:**
${formattedCriteria}

**Target Files:** ${formattedImpactFiles}

*Constraint: You must ensure all modifications strictly adhere to the Acceptance Criteria listed above. Your output will be graded by a Semantic Auditor upon PR submission.*
=========================================`;

  try {
    let fileContextString = "";
    if (impactFiles && impactFiles.length > 0) {
      for (const filePath of impactFiles) {
        fileContextString += `--- ${filePath} ---\n`;
        try {
          const fullPath = path.join(process.cwd(), filePath);
          const content = await fs.readFile(fullPath, "utf-8");
          fileContextString += `\`\`\`\n${content}\n\`\`\`\n\n`;
          } catch {
          fileContextString += `(File does not exist yet)\n\n`;
        }
      }
    }

    const systemPrompt = "You are the Nexus Lead Architect. The user has provided a high-level coding intent. You have been provided the Goal's Acceptance Criteria and the literal code of the exact files that must be modified. Your job is to compile this into a strict, step-by-step Execution Mandate for a subordinate AI coding agent. Do not write the actual code. Write the blueprint.";

    const userPrompt = `
**Goal Title:** ${goal.title}
**Description:** ${goal.description || 'N/A'}

**Acceptance Criteria:**
${formattedCriteria}

**User's Raw Prompt:**
${basePrompt}

${fileContextString}
`;

    const { text } = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
    });

    return text;
    } catch (error) {
    console.error("Failed to compile prompt using LLM, falling back to static prompt:", error);
    return fallbackPrompt;
  }
}
