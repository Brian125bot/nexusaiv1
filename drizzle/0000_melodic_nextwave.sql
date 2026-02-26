CREATE TYPE "public"."goal_status" AS ENUM('backlog', 'in-progress', 'completed', 'drifted');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('queued', 'executing', 'verifying', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "file_locks" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"file_path" text NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_locks_file_path_unique" UNIQUE("file_path")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "goal_status" DEFAULT 'backlog' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"external_session_id" text,
	"goal_id" uuid,
	"source_repo" text DEFAULT '' NOT NULL,
	"jules_session_url" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"branch_name" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"status" "session_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_external_session_id_unique" UNIQUE("external_session_id")
);
--> statement-breakpoint
ALTER TABLE "file_locks" ADD CONSTRAINT "file_locks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;