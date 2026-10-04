DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'fuzzystrmatch' AND n.nspname = 'extensions') THEN
    RAISE EXCEPTION 'Extension fuzzystrmatch must exist in schema extensions (the database owner creates it there before Paperclip migrates)';
  END IF;
END $$;
