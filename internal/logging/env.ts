import { createEnv } from "@t3-oss/env-core"
import * as z from "zod"

/** Emit logs to backend (e.g. Axiom) only in non-dev environments */
export function shouldEmitLogsToBackend(env: { APP_ENV?: string }): boolean {
  return env.APP_ENV !== "development"
}

/** Emit metrics only in production */
export function shouldEmitMetrics(env: { APP_ENV?: string }): boolean {
  return env.APP_ENV === "production"
}

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  },
  server: {
    AXIOM_API_TOKEN: z.string(),
    AXIOM_DATASET: z.string(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  onValidationError: (issues) => {
    throw new Error(`Invalid environment variables in Logging: ${JSON.stringify(issues, null, 2)}`)
  },
})
