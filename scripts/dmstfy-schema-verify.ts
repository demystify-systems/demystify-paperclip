// Runs Paperclip's own migrator (packages/db/src/client.ts) against DATABASE_URL and fails unless
// every migration is applied. Table placement is counted by the caller (see dmstfy-schema-check.yml).
import { applyPendingMigrations, inspectMigrations } from "../packages/db/src/client.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

await applyPendingMigrations(url);
const state = await inspectMigrations(url);
if (state.status !== "upToDate") {
  throw new Error(`migrations still pending: ${state.pendingMigrations.join(", ")}`);
}
console.log(`applied ${state.appliedMigrations.length} of ${state.availableMigrations.length} migrations`);
process.exit(0);
