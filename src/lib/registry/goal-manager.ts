import { randomUUID } from "crypto";
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
    const normalizedCriteria = acceptanceCriteria.map((text) => ({
      id: randomUUID(),
      text,
      met: false,
    }));

    const result = await db.insert(goals).values({
      title,
      description,
      acceptanceCriteria: normalizedCriteria,
      status: "backlog",
    }).returning({ id: goals.id });

    return result[0].id;
  }

  /**
   * Updates the status of a specific acceptance criterion.
   */
  static async updateGoalProgress(goalId: string, criteriaIndex: number, isMet: boolean) {
    const goal = await db.query.goals.findFirst({
      where: eq(goals.id, goalId),
    });

    if (!goal) throw new Error("Goal not found");
    
    const criteria = (goal.acceptanceCriteria as AcceptanceCriterion[]) || [];
    const item = criteria[criteriaIndex];

    if (item !== undefined) {
       item.met = isMet;
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
