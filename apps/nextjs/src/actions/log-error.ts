"use server"

import { AxiomLogger, ConsoleLogger } from "@unprice/logging"
import { env } from "~/env"

export async function logError(error: Error | string, errorInfo?: unknown) {
  const message = typeof error === "string" ? error : error.message
  const errorObj = typeof error === "string" ? new Error(error) : error

  // Use a fallback request ID since we might not have one in this context
  const requestId = `global-error-${Date.now().toString()}`

  const logger = env.AXIOM_API_TOKEN
    ? new AxiomLogger({
        apiKey: env.AXIOM_API_TOKEN,
        requestId,
        dataset: env.AXIOM_DATASET,
        environment: env.NODE_ENV,
        service: "nextjs-client-error",
        logLevel: "error",
      })
    : new ConsoleLogger({
        requestId,
        environment: env.NODE_ENV,
        service: "nextjs-client-error",
        logLevel: "error",
      })

  logger.error(message, {
    ...errorObj,
    errorInfo: errorInfo as Record<string, unknown>,
  })

  await logger.flush()
}
