import { defineConfig } from "drizzle-kit"

export default defineConfig({
  out: "./src/ingestion/audit/drizzle",
  schema: "./src/ingestion/audit/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
})
