import { defineConfig } from "drizzle-kit"

export default defineConfig({
  out: "./src/ingestion/drizzle",
  schema: "./src/ingestion/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
})
