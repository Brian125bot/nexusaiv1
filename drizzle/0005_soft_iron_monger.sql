CREATE TYPE "public"."lock_type" AS ENUM('shared', 'exclusive');--> statement-breakpoint
ALTER TABLE "file_locks" DROP CONSTRAINT "file_locks_file_path_unique";--> statement-breakpoint
ALTER TABLE "cascades" ADD COLUMN "is_ast_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "file_locks" ADD COLUMN "type" "lock_type" DEFAULT 'exclusive' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "remediation_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "unq_file_session" ON "file_locks" USING btree ("file_path","session_id");