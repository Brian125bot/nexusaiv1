import { db } from "@/db";
import { goals } from "@/db/schema";
import { eq } from "drizzle-orm";

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

  const enrichedPrompt = `${basePrompt}

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

  return enrichedPrompt;
}
