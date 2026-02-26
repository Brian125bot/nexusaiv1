import { pgTable, uuid, text, serial, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";

export const goalStatusEnum = pgEnum("goal_status", ["backlog", "in-progress", "completed", "drifted"]);
export const sessionStatusEnum = pgEnum("session_status", ["queued", "executing", "verifying", "completed", "failed"]);

export interface AcceptanceCriterion {
  text: string;
  met: boolean;
}

export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  acceptanceCriteria: jsonb("acceptance_criteria").$type<(string | AcceptanceCriterion)[]>().default([]).notNull(),
  reviewArtifacts: jsonb("review_artifacts")
    .$type<Array<{ type: "pull_request"; url: string; sessionExternalId: string; createdAt: string }>>()
    .default([])
    .notNull(),
  status: goalStatusEnum("status").default("backlog").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // Internal Nexus Session ID
  externalSessionId: text("external_session_id").unique(),
  goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
  sourceRepo: text("source_repo").default("").notNull(),
  lastReviewedCommit: text("last_reviewed_commit"),
  julesSessionUrl: text("jules_session_url"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  branchName: text("branch_name").notNull(),
  baseBranch: text("base_branch").default("main").notNull(),
  status: sessionStatusEnum("status").default("queued").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fileLocks = pgTable("file_locks", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: 'cascade' }).notNull(),
  filePath: text("file_path").unique().notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).defaultNow().notNull(),
});
