CREATE TYPE "public"."cascade_status" AS ENUM('analyzing', 'dispatched', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "cascades" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_session_id" text,
	"core_files_changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"downstream_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repair_job_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"status" "cascade_status" DEFAULT 'analyzing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cascade_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_cascade_id_cascades_id_fk" FOREIGN KEY ("cascade_id") REFERENCES "public"."cascades"("id") ON DELETE set null ON UPDATE no action;