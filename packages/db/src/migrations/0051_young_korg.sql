DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm' AND n.nspname = 'extensions') THEN
    RAISE EXCEPTION 'Extension pg_trgm must exist in schema extensions (the database owner creates it there before Paperclip migrates)';
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX "issue_comments_body_search_idx" ON "issue_comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_title_search_idx" ON "issues" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_identifier_search_idx" ON "issues" USING gin ("identifier" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_description_search_idx" ON "issues" USING gin ("description" gin_trgm_ops);
