import { type StandardSchemaV1, createEnv } from "@t3-oss/env-core"
import { env as envAnalytics } from "@unprice/analytics/env"
import { env as envDb } from "@unprice/db/env"
import { env as envLogging } from "@unprice/logging/env"
import { env as envServices } from "@unprice/services/env"
import { z } from "zod"
import type { DurableObjectUsagelimiter } from "~/usagelimiter/do"
import type { DurableObjectProject } from "./project/do"

export const cloudflareRatelimiter = z.custom<{
  limit: (opts: { key: string }) => Promise<{ success: boolean }>
}>((r) => !!r && typeof r.limit === "function")

export const r2Bucket = z.custom<R2Bucket>((b) => typeof b === "object")
export const pipelinesBinding = z.custom<{ send: (records: unknown[]) => Promise<void> }>(
  (binding) => !!binding && typeof binding === "object" && typeof binding.send === "function"
)

// This function should be called at the start of each request.
export function createRuntimeEnv(workerEnv: Record<string, string | number | boolean | undefined>) {
  return createEnv({
    shared: {
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    },
    server: {
      AUTH_SECRET: z.string(),
      VERSION: z.string().default("unknown"),
      MAIN_PROJECT_ID: z.string().optional(),
      usagelimit: z.custom<DurableObjectNamespace<DurableObjectUsagelimiter>>(
        (ns) => typeof ns === "object"
      ),
      projectdo: z.custom<DurableObjectNamespace<DurableObjectProject>>(
        (ns) => typeof ns === "object"
      ),
      RL_FREE_600_60s: cloudflareRatelimiter,
      CLOUDFLARE_ZONE_ID: z.string().optional(),
      CLOUDFLARE_API_TOKEN: z.string().optional(),
      CLOUDFLARE_API_TOKEN_LAKEHOUSE: z.string().optional(),
      CLOUDFLARE_ACCOUNT_ID_LAKEHOUSE: z.string().optional(),
      CLOUDFLARE_PARENT_ACCESS_KEY_ID_LAKEHOUSE: z.string().optional(),
      CLOUDFLARE_CACHE_DOMAIN: z.string().optional(),
      LAKEHOUSE: r2Bucket.optional(),
      LAKEHOUSE_PIPELINE_USAGE: pipelinesBinding,
      LAKEHOUSE_PIPELINE_VERIFICATION: pipelinesBinding,
      LAKEHOUSE_PIPELINE_METADATA: pipelinesBinding,
      LAKEHOUSE_PIPELINE_ENTITLEMENT_SNAPSHOT: pipelinesBinding,
      LAKEHOUSE_BUCKET_NAME: z.string().optional(),
      LAKEHOUSE_ICEBERG_PREFIX: z.string().optional(),
    },
    emptyStringAsUndefined: true,
    runtimeEnv: workerEnv,
    extends: [envServices, envDb, envAnalytics, envLogging],
    skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
    onValidationError: (issues: readonly StandardSchemaV1.Issue[]) => {
      throw new Error(`Invalid environment variables in API: ${JSON.stringify(issues, null, 2)}`)
    },
  })
}

export type Env = ReturnType<typeof createRuntimeEnv>
