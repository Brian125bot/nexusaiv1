import { pgTable, uuid, text, serial, timestamp, jsonb, pgEnum, integer, boolean } from "drizzle-orm/pg-core";

export const goalStatusEnum = pgEnum("goal_status", ["backlog", "in-progress", "completed", "drifted"]);
export const sessionStatusEnum = pgEnum("session_status", ["queued", "executing", "verifying", "completed", "failed"]);
export const cascadeStatusEnum = pgEnum("cascade_status", ["analyzing", "dispatched", "completed", "failed"]);

export interface AcceptanceCriterion {
  id: string;
  text: string;
  met: boolean;
  reasoning: string | null;
  files?: string[];
}

export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  acceptanceCriteria: jsonb("acceptance_criteria").$type<AcceptanceCriterion[]>().default([]).notNull(),
  reviewArtifacts: jsonb("review_artifacts")
    .$type<Array<{ type: "pull_request"; url: string; sessionExternalId: string; createdAt: string }>>()
    .default([])
    .notNull(),
  status: goalStatusEnum("status").default("backlog").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const cascades = pgTable("cascades", {
  id: text("id").primaryKey(),
  triggerSessionId: text("trigger_session_id"), // Not a strict FK to avoid circular dependencies with sessions
  coreFilesChanged: jsonb("core_files_changed").$type<string[]>().default([]).notNull(),
  downstreamFiles: jsonb("downstream_files").$type<string[]>().default([]).notNull(),
  repairJobCount: integer("repair_job_count").default(0).notNull(),
  summary: text("summary"),
  status: cascadeStatusEnum("status").default("analyzing").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // Internal Nexus Session ID
  externalSessionId: text("external_session_id").unique(),
  goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
  cascadeId: text("cascade_id").references(() => cascades.id, { onDelete: "set null" }),
  isCascadeRoot: boolean("is_cascade_root").default(false).notNull(),
  sourceRepo: text("source_repo").default("").notNull(),
  lastReviewedCommit: text("last_reviewed_commit"),
  julesSessionUrl: text("jules_session_url"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  remediationDepth: integer("remediation_depth").default(0).notNull(),
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
