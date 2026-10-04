-- Owner-side setup that the core migration performs in the shared database (run as superuser).
-- Mirrors what an unprivileged Paperclip role finds: schemas and extensions exist, no CREATE on the database.
create schema paperclip;
create schema extensions;
create extension pg_trgm schema extensions;
create extension fuzzystrmatch schema extensions;
create role paperclip_app login password 'paperclip_app' nosuperuser nocreatedb nocreaterole;
grant usage, create on schema paperclip to paperclip_app;
grant usage on schema extensions to paperclip_app;
alter role paperclip_app set search_path = paperclip, extensions;
revoke create on schema public from public;
