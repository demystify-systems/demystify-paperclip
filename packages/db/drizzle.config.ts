import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./dist/schema/*.js",
  out: "./src/migrations",
  dialect: "postgresql",
  migrations: { table: "__drizzle_migrations", schema: "paperclip" }, // dmstfy-schema-patch
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
