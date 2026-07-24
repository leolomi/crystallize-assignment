CREATE TYPE "public"."task_kind" AS ENUM('product_price_update', 'catalogue_reindex');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('ingesting', 'pending', 'starting', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_weight" AS ENUM('light', 'heavy');--> statement-breakpoint
CREATE TYPE "public"."task_row_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "task_kind" DEFAULT 'product_price_update' NOT NULL,
	"status" "task_status" DEFAULT 'ingesting' NOT NULL,
	"weight" "task_weight" DEFAULT 'heavy' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"error" text,
	"runner_pid" integer,
	"heartbeat_at" timestamp with time zone,
	"restarts" integer DEFAULT 0 NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_row" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "task_row_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_row" ADD CONSTRAINT "task_row_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_pending_idx" ON "task" USING btree ("weight","created_at") WHERE "task"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "task_active_idx" ON "task" USING btree ("heartbeat_at") WHERE "task"."status" in ('starting', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "task_row_task_row_idx" ON "task_row" USING btree ("task_id","row_index");--> statement-breakpoint
CREATE INDEX "task_row_pending_idx" ON "task_row" USING btree ("task_id","row_index") WHERE "task_row"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "task_row_failed_idx" ON "task_row" USING btree ("task_id","row_index") WHERE "task_row"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "task_row_done_idx" ON "task_row" USING btree ("task_id") WHERE "task_row"."status" = 'done';