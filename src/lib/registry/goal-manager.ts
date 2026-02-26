import { db } from "@/db";
import { goals, type AcceptanceCriterion } from "@/db/schema";
import { eq } from "drizzle-orm";

export class GoalManager {
  /**
   * Creates a new architectural goal.
   * 
   * @param title Goal title
   * @param description Goal description
   * @param acceptanceCriteria List of criteria strings
   * @returns The created goal ID
   */
  static async createGoal(title: string, description: string, acceptanceCriteria: string[]) {
    const result = await db.insert(goals).values({
      title,
      description,
      acceptanceCriteria,
      status: "backlog",
    }).returning({ id: goals.id });

    return result[0].id;
  }

  /**
   * Updates the status of a specific acceptance criterion.
   * Note: This spec implies acceptanceCriteria is an array of objects if we track "is_met" per item.
   * But the schema says JSONB Array of strings. 
   * Usually, we'd want objects like { criteria: string, is_met: boolean }.
   * For simplicity and following the literal spec: "check off items as Jules completes them".
   * 
   * Let's refine the criteria to be objects: { text: string, met: boolean }.
   */
  static async updateGoalProgress(goalId: string, criteriaIndex: number, isMet: boolean) {
    const goal = await db.query.goals.findFirst({
      where: eq(goals.id, goalId),
    });

    if (!goal) throw new Error("Goal not found");

    // We'll assume the JSONB stores an array of strings as per schema, 
    // or objects if we want more data.
    // The spec says: ["No hardcoded secrets", "Uses Lucia Auth"]
    // If we want to "check them off", we probably need to store them as objects.
    // Let's stick to the spec and use objects if needed, but for now let's see.
    
    // To be flexible, if we can't "check off" a string, let's just log it for now
    // OR we change the type to store objects. 
    // I'll update schema.ts to use objects for acceptanceCriteria.
    
    // Wait, the spec says "JSONB Array". 
    // I'll assume it's an array of objects { description: string, completed: boolean }
    
    const criteria = (goal.acceptanceCriteria as (string | AcceptanceCriterion)[]) || [];
    const item = criteria[criteriaIndex];

    if (item !== undefined) {
       if (typeof item === 'string') {
           // Upgrade string to object if necessary
           criteria[criteriaIndex] = { text: item, met: isMet };
       } else {
           item.met = isMet;
       }
    }

    await db.update(goals)
      .set({ acceptanceCriteria: criteria })
      .where(eq(goals.id, goalId));
  }

  static async getGoal(goalId: string) {
    return await db.query.goals.findFirst({
      where: eq(goals.id, goalId),
    });
  }
}
