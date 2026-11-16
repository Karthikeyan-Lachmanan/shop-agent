ALTER TABLE "sessions" ADD COLUMN "customer" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tokens_used" integer DEFAULT 0 NOT NULL;