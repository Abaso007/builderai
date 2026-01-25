import { ConsoleLogger } from "@unprice/logging"
import { env } from "../env"
import { Analytics } from "./analytics"

export const analytics = new Analytics({
  emit: env.EMIT_ANALYTICS && env.EMIT_ANALYTICS.toString() === "true",
  tinybirdToken: env.TINYBIRD_TOKEN,
  tinybirdUrl: env.TINYBIRD_URL,
  logger: new ConsoleLogger({
    requestId: "analytics",
    environment: env.NODE_ENV,
    service: "analytics",
    logLevel: env.VERCEL_ENV === "production" ? "warn" : "info",
  }),
})
