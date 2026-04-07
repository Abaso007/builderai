import { defineConfig } from "drizzle-kit"

export default defineConfig({
  out: "./src/ingestion/entitlements/drizzle",
  schema: "./src/ingestion/entitlements/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
})
