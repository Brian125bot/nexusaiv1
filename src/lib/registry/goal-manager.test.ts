import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GoalManager } from "./goal-manager";
import { db } from "@/db";
import { goals, type AcceptanceCriterion } from "@/db/schema";

describe("GoalManager", () => {
  beforeAll(async () => {
    await db.delete(goals);
  });

  afterAll(async () => {
    await db.delete(goals);
  });

  it("should create a goal with acceptance criteria", async () => {
    const title = "Implement Multi-tenant Auth";
    const description = "Requirement for multi-tenant auth with Lucia";
    const criteria = ["No hardcoded secrets", "Uses Lucia Auth"];
    
    const goalId = await GoalManager.createGoal(title, description, criteria);
    expect(goalId).toBeDefined();

    const goal = await GoalManager.getGoal(goalId);
    expect(goal).toBeDefined();
    expect(goal?.title).toBe(title);
    expect(goal?.acceptanceCriteria).toMatchObject([
      { text: "No hardcoded secrets", met: false },
      { text: "Uses Lucia Auth", met: false }
    ]);
  });

  it("should update goal progress", async () => {
    const title = "Test Goal";
    const criteria = ["Criteria 1", "Criteria 2"];
    const goalId = await GoalManager.createGoal(title, "Desc", criteria);

    await GoalManager.updateGoalProgress(goalId, 0, true);
    
    const updatedGoal = await GoalManager.getGoal(goalId);
    const updatedCriteria = updatedGoal?.acceptanceCriteria as AcceptanceCriterion[];
    const firstItem = updatedCriteria[0];
    
    expect(typeof firstItem).toBe("object");
    expect(firstItem.met).toBe(true);
    expect(firstItem.text).toBe("Criteria 1");
  });
});
