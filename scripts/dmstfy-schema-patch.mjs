#!/usr/bin/env node
// Demystify fork patch: keep Paperclip in its own Postgres schema (default "paperclip").
//
//   node scripts/dmstfy-schema-patch.mjs            apply the patch (idempotent)
//   node scripts/dmstfy-schema-patch.mjs --check    exit 1 if anything is not patched
//   node scripts/dmstfy-schema-patch.mjs --selftest prove the check can fail
//
// Schema name: PAPERCLIP_DB_SCHEMA or --schema <name>. Zero dependencies. See DMSTFY-PATCHES.md.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SCHEMA = "paperclip";
const EXTENSIONS_SCHEMA = "extensions";
const IDENT = /^[a-z_][a-z0-9_]*$/;
const MARK = "dmstfy-schema-patch";

const MIGRATIONS = "packages/db/src/migrations";
const CLIENT = "packages/db/src/client.ts";
const SAFETY = "packages/db/src/check-migration-safety.ts";
const DRIZZLE_CONFIG = "packages/db/drizzle.config.ts";
const BACKUP_LIB = "packages/db/src/backup-lib.ts";
const PLUGIN_DB = "server/src/services/plugin-database.ts";

// ---------------------------------------------------------------- migrations

function extensionCheck(extension) {
  return [
    "DO $$ BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = '${extension}' AND n.nspname = '${EXTENSIONS_SCHEMA}') THEN`,
    `    RAISE EXCEPTION 'Extension ${extension} must exist in schema ${EXTENSIONS_SCHEMA} (the database owner creates it there before Paperclip migrates)';`,
    "  END IF;",
    "END $$;",
  ].join("\n");
}

export function patchMigration(sql, schema) {
  let out = sql.replaceAll('"public".', `"${schema}".`);
  out = out.replace(/CREATE EXTENSION IF NOT EXISTS (pg_trgm|fuzzystrmatch);/g, (_m, ext) => extensionCheck(ext));
  return out;
}

// -------------------------------------------------------------------- client

function must(src, needle, label) {
  if (!src.includes(needle)) {
    throw new Error(`patch anchor not found in ${label}: ${needle.slice(0, 70)} (upstream changed; update the script)`);
  }
}

function swap(src, from, to, label) {
  must(src, from, label);
  return src.replaceAll(from, to);
}

const CONSTANT_RE = /const PAPERCLIP_DB_SCHEMA = "[a-z_][a-z0-9_]*";/;

const CLIENT_PRELUDE = (schema) => `const PAPERCLIP_DB_SCHEMA = "${schema}"; // ${MARK}: every Paperclip object lives here
const PAPERCLIP_EXTENSIONS_SCHEMA = "${EXTENSIONS_SCHEMA}";
// Role-level search_path wins when set; PAPERCLIP_DB_SEARCH_PATH="" turns the connection option off.
const PAPERCLIP_SEARCH_PATH =
  process.env.PAPERCLIP_DB_SEARCH_PATH ?? \`\${PAPERCLIP_DB_SCHEMA},\${PAPERCLIP_EXTENSIONS_SCHEMA}\`;
const PAPERCLIP_PG_OPTIONS = PAPERCLIP_SEARCH_PATH
  ? { connection: { search_path: PAPERCLIP_SEARCH_PATH } }
  : {};

// Embedded and superuser setups get the schema (and the extensions) created; an unprivileged role
// expects the owner to have made them, and the migrations that need them say so if they are missing.
async function ensureDbSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  const exists = async (name: string) =>
    (await sql<{ one: number }[]>\`select 1 as one from pg_namespace where nspname = \${name}\`).length > 0;
  if (!(await exists(PAPERCLIP_DB_SCHEMA))) {
    await sql.unsafe(\`CREATE SCHEMA \${quoteIdentifier(PAPERCLIP_DB_SCHEMA)}\`);
  }
  if (!(await exists(PAPERCLIP_EXTENSIONS_SCHEMA))) {
    try {
      await sql.unsafe(\`CREATE SCHEMA \${quoteIdentifier(PAPERCLIP_EXTENSIONS_SCHEMA)}\`);
    } catch {
      return;
    }
  }
  for (const extension of ["pg_trgm", "fuzzystrmatch"]) {
    const present = await sql<{ one: number }[]>\`
      select 1 as one from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = \${extension} and n.nspname = \${PAPERCLIP_EXTENSIONS_SCHEMA}
    \`;
    if (present.length > 0) continue;
    try {
      await sql.unsafe(\`CREATE EXTENSION IF NOT EXISTS \${extension} SCHEMA \${quoteIdentifier(PAPERCLIP_EXTENSIONS_SCHEMA)}\`);
    } catch {
      // not allowed for this role: the owner creates it; the migration reports it clearly
    }
  }
}
`;

export function patchClient(src, schema) {
  if (src.includes(MARK)) return src.replace(CONSTANT_RE, `const PAPERCLIP_DB_SCHEMA = "${schema}";`);
  let out = src;
  out = swap(
    out,
    'const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";\n',
    `const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";\n${CLIENT_PRELUDE(schema)}`,
    CLIENT,
  );
  out = swap(out, "postgres(url, { max: 1, onnotice: () => {} })", "postgres(url, { max: 1, onnotice: () => {}, ...PAPERCLIP_PG_OPTIONS })", CLIENT);
  out = swap(out, "const sql = postgres(url);", "const sql = postgres(url, PAPERCLIP_PG_OPTIONS);", CLIENT);
  out = swap(out, "table_schema = 'public'", "table_schema = ${PAPERCLIP_DB_SCHEMA}", CLIENT);
  out = swap(out, "n.nspname = 'public'", "n.nspname = ${PAPERCLIP_DB_SCHEMA}", CLIENT);
  // the Drizzle journal lives in the Paperclip schema, never in "drizzle" or "public"
  out = swap(out, 'const drizzleSchema = quoteIdentifier("drizzle");', "const drizzleSchema = quoteIdentifier(PAPERCLIP_DB_SCHEMA);", CLIENT);
  out = swap(out, "    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);\n", "    await ensureDbSchema(sql);\n", CLIENT);
  out = swap(out, '?? "drizzle";', "?? PAPERCLIP_DB_SCHEMA;", CLIENT);
  out = swap(
    out,
    "WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'",
    "WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r' AND n.nspname = ${PAPERCLIP_DB_SCHEMA}",
    CLIENT,
  );
  const lookup = /  const drizzleSchema = rows\.find\([^\n]*\n  if \(drizzleSchema\)[^\n]*\n\n  const publicSchema = rows\.find\([^\n]*\n  if \(publicSchema\)[^\n]*\n\n/;
  if (!lookup.test(out)) throw new Error(`patch anchor not found in ${CLIENT}: journal schema lookup`);
  out = out.replace(lookup, "");
  // Drizzle's migrate() runs CREATE SCHEMA IF NOT EXISTS, which an unprivileged role is refused even
  // when the schema exists. The client's own journal-aware applier writes the same journal table.
  const viaDrizzle = /const db = drizzlePg\(sql\);\n(\s*)await migratePg\(db, \{ migrationsFolder: MIGRATIONS_FOLDER \}\);/g;
  if (!viaDrizzle.test(out)) throw new Error(`patch anchor not found in ${CLIENT}: migratePg call`);
  out = out.replace(viaDrizzle, "await applyPendingMigrationsManually(url, await listMigrationFiles());");
  out = swap(out, 'import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";\n', "", CLIENT);
  return out;
}

// ------------------------------------------------------- migration safety lint

export function patchSafety(src, schema) {
  const pairs = [
    ['(?:"public"|public)', `(?:"${schema}"|${schema})`],
    ['(?:"public"\\s*\\.\\s*)', `(?:"${schema}"\\s*\\.\\s*)`],
    ['.replace(/^"public"\\s*\\.\\s*/i, "")', `.replace(/^"${schema}"\\s*\\.\\s*/i, "")`],
    [".replace(/^public\\s*\\.\\s*/i, \"\")", `.replace(/^${schema}\\s*\\.\\s*/i, "")`],
  ];
  let out = src;
  for (const [from, to] of pairs) {
    if (out.includes(from)) out = out.replaceAll(from, to);
    else must(out, to, SAFETY);
  }
  return out;
}

// ----------------------------------------------------- tests that probe the schema

const SCHEMA_TESTS = [
  "client.test.ts",
  "inbox-archive-agent-policies-migration.test.ts",
  "issue-comment-derived-attribution-migration.test.ts",
  "nested-skill-folders-migration.test.ts",
].map((f) => `packages/db/src/${f}`);

export function patchSchemaTest(src, schema) {
  return src
    .replaceAll('"drizzle"."__drizzle_migrations"', `"${schema}"."__drizzle_migrations"`)
    .replaceAll("'public'", `'${schema}'`)
    .replaceAll("'public.", `'${schema}.`);
}

// ------------------------------------------------------------ drizzle-kit config

export function patchDrizzleConfig(src, schema) {
  if (src.includes(MARK)) return src.replace(/schema: "[a-z_][a-z0-9_]*", \/\/ dmstfy/, `schema: "${schema}", // dmstfy`);
  must(src, '  dialect: "postgresql",\n', DRIZZLE_CONFIG);
  return src.replace(
    '  dialect: "postgresql",\n',
    `  dialect: "postgresql",\n  migrations: { table: "__drizzle_migrations", schema: "${schema}" }, // ${MARK}\n`,
  );
}

// ------------------------------------------- backup restore and plugin database

// A logical backup lists extensions with their schema ("extensions"); the restore target may not have
// that schema yet, so the dump creates it before the extension statement.
export function patchBackupLib(src) {
  if (src.includes(MARK)) return src;
  const anchor = "      for (const extension of extensions) {\n        emitStatement(\n          `CREATE EXTENSION IF NOT EXISTS";
  must(src, anchor, BACKUP_LIB);
  const create =
    `      for (const extensionSchema of new Set(extensions.map((extension) => extension.schema_name))) {\n` +
    `        if (extensionSchema === "public") continue; // ${MARK}: the restore target may lack this schema\n` +
    "        emitStatement(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(extensionSchema)};`);\n" +
    `      }\n`;
  return src.replace(anchor, create + anchor);
}

// Plugins read core tables through a whitelist. Core tables live in the Paperclip schema here, so the
// whitelist applies to it as well as to "public" (upstream plugins and docs still say public.<table>).
export function patchPluginDatabase(src, schema) {
  if (src.includes(MARK)) return src.replace(/const PAPERCLIP_CORE_SCHEMA = "[a-z_][a-z0-9_]*";/, `const PAPERCLIP_CORE_SCHEMA = "${schema}";`);
  let out = src;
  const helper =
    `const PAPERCLIP_CORE_SCHEMA = "${schema}"; // ${MARK}\n\n` +
    "function isCoreSchema(schema: string): boolean {\n" +
    '  return schema === "public" || schema === PAPERCLIP_CORE_SCHEMA;\n' +
    "}\n\n" +
    "// Plugins keep writing public.<core table>; the core tables live in the Paperclip schema, so the validated\n" +
    "// statement is pointed there just before it runs.\n" +
    "function toCoreSchemaSql(statement: string): string {\n" +
    "  return statement.replace(/(?<![\\w.\"])(?:\"public\"|public)\\s*\\.\\s*(?=[a-z_\"])/gi, `\"${PAPERCLIP_CORE_SCHEMA}\".`);\n" +
    "}\n\n";
  out = swap(out, "function assertAllowedPublicRead(", `${helper}function assertAllowedPublicRead(`, PLUGIN_DB);
  out = swap(out, 'if (ref.schema !== "public") return;', "if (!isCoreSchema(ref.schema)) return;", PLUGIN_DB);
  out = swap(out, 'if (ref.schema === "public") {', "if (isCoreSchema(ref.schema)) {", PLUGIN_DB);
  out = swap(out, "references public.${ref.table}", "references ${ref.schema}.${ref.table}", PLUGIN_DB);
  out = swap(out, "objects in public.${ref.table}", "objects in ${ref.schema}.${ref.table}", PLUGIN_DB);
  out = swap(out, "await client.execute(sql.raw(statement));", "await client.execute(sql.raw(toCoreSchemaSql(statement)));", PLUGIN_DB);
  out = swap(
    out,
    "  if (params.length === 0) return sql.raw(statement);\n",
    "  statement = toCoreSchemaSql(statement);\n  if (params.length === 0) return sql.raw(statement);\n",
    PLUGIN_DB,
  );
  return out;
}

// ---------------------------------------------------------------------- driver

function listMigrations(root) {
  const dir = path.join(root, MIGRATIONS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(MIGRATIONS, f));
}

function targets(root, schema) {
  const files = listMigrations(root).map((rel) => [rel, (s) => patchMigration(s, schema)]);
  files.push([CLIENT, (s) => patchClient(s, schema)]);
  files.push([SAFETY, (s) => patchSafety(s, schema)]);
  files.push([DRIZZLE_CONFIG, (s) => patchDrizzleConfig(s, schema)]);
  files.push([BACKUP_LIB, (s) => patchBackupLib(s)]);
  files.push([PLUGIN_DB, (s) => patchPluginDatabase(s, schema)]);
  const migrationCount = files.length - 5;
  for (const rel of SCHEMA_TESTS.filter((r) => existsSync(path.join(root, r)))) files.push([rel, (s) => patchSchemaTest(s, schema)]);
  return { migrationCount, files };
}

/** Returns { changed: string[], migrationCount, problems: string[] }; writes only when write is true. */
export function run(root, schema, write) {
  const problems = [];
  const changed = [];
  const { migrationCount, files } = targets(root, schema);
  if (migrationCount === 0) problems.push(`no migration files found under ${MIGRATIONS}`);
  for (const [rel, transform] of files) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      problems.push(`missing ${rel}`);
      continue;
    }
    const before = readFileSync(abs, "utf8");
    let after;
    try {
      after = transform(before);
    } catch (error) {
      problems.push(`${rel}: ${error.message}`);
      continue;
    }
    if (after !== before) {
      changed.push(rel);
      if (write) writeFileSync(abs, after);
    }
  }
  if (!write) {
    for (const rel of listMigrations(root)) {
      const sql = readFileSync(path.join(root, rel), "utf8");
      if (/^\s*CREATE EXTENSION/im.test(sql)) problems.push(`${rel}: still runs CREATE EXTENSION`);
    }
    const client = existsSync(path.join(root, CLIENT)) ? readFileSync(path.join(root, CLIENT), "utf8") : "";
    if (/'public'/.test(client)) problems.push(`${CLIENT}: still probes 'public'`);
  }
  return { changed, migrationCount, problems };
}

function selftest() {
  const schema = DEFAULT_SCHEMA;
  const fail = (msg) => {
    console.error(`selftest FAILED: ${msg}`);
    process.exit(1);
  };
  // 1. the transforms do what they say and are idempotent
  const sample = 'CREATE TABLE "public"."a" ("id" uuid);--> statement-breakpoint\nCREATE EXTENSION IF NOT EXISTS pg_trgm;';
  const patched = patchMigration(sample, schema);
  if (patched.includes('"public".') || /^\s*CREATE EXTENSION/im.test(patched)) fail("migration transform left public or CREATE EXTENSION");
  if (!patched.includes(`"${schema}"."a"`)) fail("migration transform did not rewrite the table");
  if (patchMigration(patched, schema) !== patched) fail("migration transform is not idempotent");

  // 2. a throwaway tree: patched passes, a corrupted migration fails, zero files fails
  const root = mkdtempSync(path.join(tmpdir(), "dmstfy-schema-selftest-"));
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const real = path.resolve(here, "..");
    for (const rel of [CLIENT, SAFETY, DRIZZLE_CONFIG, BACKUP_LIB, PLUGIN_DB]) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), readFileSync(path.join(real, rel), "utf8"));
    }
    mkdirSync(path.join(root, MIGRATIONS), { recursive: true });
    const migration = path.join(root, MIGRATIONS, "0000_x.sql");
    writeFileSync(migration, sample);
    run(root, schema, true);
    if (run(root, schema, false).problems.length || run(root, schema, false).changed.length) fail("patched tree does not pass --check");

    writeFileSync(migration, patchMigration(sample, schema) + '\nALTER TABLE "public"."a" ADD COLUMN "b" text;');
    if (run(root, schema, false).changed.length === 0) fail("a corrupted migration (public reference) passed --check");

    writeFileSync(migration, patchMigration(sample, schema));
    writeFileSync(migration, readFileSync(migration, "utf8") + "\nCREATE EXTENSION IF NOT EXISTS vector;");
    if (!run(root, schema, false).problems.some((p) => p.includes("CREATE EXTENSION"))) fail("a stray CREATE EXTENSION passed --check");

    rmSync(migration);
    if (run(root, schema, false).problems.length === 0) fail("zero migration files passed --check");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("selftest ok: transforms are idempotent; corrupted migration, stray extension and zero files all fail --check");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return selftest();
  const schemaIdx = argv.indexOf("--schema");
  const schema = (schemaIdx >= 0 ? argv[schemaIdx + 1] : process.env.PAPERCLIP_DB_SCHEMA) || DEFAULT_SCHEMA;
  if (!IDENT.test(schema) || schema === "public") {
    console.error(`invalid schema name "${schema}": use lower-case letters, digits, underscore; not "public"`);
    process.exit(2);
  }
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const check = argv.includes("--check");
  const { changed, migrationCount, problems } = run(root, schema, !check);
  if (check) {
    if (changed.length || problems.length) {
      for (const rel of changed) console.error(`not patched: ${rel}`);
      for (const p of problems) console.error(`problem: ${p}`);
      console.error(`dmstfy-schema-patch --check FAILED. Run: node scripts/dmstfy-schema-patch.mjs --schema ${schema}`);
      process.exit(1);
    }
    console.log(`dmstfy-schema-patch --check ok: ${migrationCount} migrations, client, safety lint and drizzle config use schema "${schema}"`);
    return;
  }
  if (problems.length) {
    for (const p of problems) console.error(`problem: ${p}`);
    process.exit(1);
  }
  console.log(`patched ${changed.length} file(s) for schema "${schema}" (${migrationCount} migrations scanned)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
