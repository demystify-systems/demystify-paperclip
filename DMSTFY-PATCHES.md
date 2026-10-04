# Demystify patches to this fork

## Schema patch: Paperclip in its own schema (PC-01)

Demystify runs Paperclip inside the shared Supabase database, in schema `paperclip`, as an unprivileged role. Upstream
hard-codes `"public".` in its migrations, so the patch rewrites it. One script does all of it:
`scripts/dmstfy-schema-patch.mjs` (zero dependencies, Node ESM).

### What it changes

| File | Change |
|---|---|
| `packages/db/src/migrations/*.sql` | `"public".` becomes `"paperclip".`; the two `CREATE EXTENSION` statements (`pg_trgm` in 0051, `fuzzystrmatch` in 0080) become checks that the extension exists in schema `extensions`, with a clear error if not |
| `packages/db/src/client.ts` | every `'public'` probe uses the Paperclip schema; the Drizzle journal `__drizzle_migrations` lives in that schema (not `drizzle`); connections set `search_path=paperclip,extensions`; migrations are applied by the client's own journal-aware applier because Drizzle's `migrate()` runs `CREATE SCHEMA IF NOT EXISTS`, which an unprivileged role is refused even when the schema exists |
| `packages/db/src/check-migration-safety.ts` | the lint strips the Paperclip schema prefix instead of `public` |
| `packages/db/src/{client,inbox-archive-agent-policies-migration,issue-comment-derived-attribution-migration,nested-skill-folders-migration}.test.ts` | the schema probes and journal references in these tests follow the Paperclip schema |
| `packages/db/drizzle.config.ts` | `migrations.schema` is the Paperclip schema |
| `packages/db/src/backup-lib.ts` | a logical backup creates each non-`public` extension schema (`extensions`) before its `CREATE EXTENSION`, so a restore into an empty database works |
| `server/src/services/plugin-database.ts` | core tables are whitelisted for plugins under the Paperclip schema as well as `public`; plugin SQL that says `public.<core table>` is pointed at the Paperclip schema just before it runs |

Schema name: `PAPERCLIP_DB_SCHEMA` or `--schema <name>`, default `paperclip`. It is baked in at patch time, so the
migrations and the client always agree. `PAPERCLIP_DB_SEARCH_PATH` overrides the connection `search_path`
(an empty string turns the connection option off and leaves it to the role).

### What the owner provides (not done by this repo)

Before Paperclip starts against the shared database, a core migration creates schema `paperclip` and schema
`extensions` with `pg_trgm` and `fuzzystrmatch` in it, and an unprivileged role with `search_path = paperclip, extensions`
(see `scripts/dmstfy-schema-setup.sql` for the exact shape CI uses). With a superuser (dev, embedded Postgres) the
client creates them itself. The core migration and a new image tag are owner steps.

### After an upstream sync

```sh
node scripts/dmstfy-schema-patch.mjs          # rewrites whatever upstream brought back; idempotent
node scripts/dmstfy-schema-patch.mjs --check  # exit 1 if anything is unpatched
git diff --stat                               # review, then commit
```

If upstream moved a line the script anchors on, it stops with `patch anchor not found in <file>`; update the script,
do not hand-edit the output. To change the schema name, run the script on a fresh upstream sync, not on a patched tree.

### How to verify

- `node scripts/dmstfy-schema-patch.mjs --selftest` proves `--check` fails on a corrupted migration, a stray
  `CREATE EXTENSION` and zero migration files.
- CI `dmstfy-schema-check` (PRs into develop) starts Postgres 16, runs `scripts/dmstfy-schema-setup.sql`, then runs
  Paperclip's own migrator as the unprivileged role `paperclip_app` and asserts: every journal migration applied,
  all tables in `paperclip`, none anywhere else, and `--check` clean.

### Not covered

The plugin SQL rewrite is textual: a string literal in plugin SQL that contains `public.` followed by a letter is rewritten too.
Existing installs with tables in `public` are not moved; the patched client starts a fresh `paperclip` schema.
Tests elsewhere in the repo that inspect `public` directly are not updated.

### Release branch (v2026.707.0)

`release/2026.707.0-dmstfy` is tag `v2026.707.0` plus this patch (the tag the pod runs today), for an image that changes
nothing but the schema. The patch there is the same script; run it on the tag, not on a patched tree.
