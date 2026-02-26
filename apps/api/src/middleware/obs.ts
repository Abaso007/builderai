import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "../hono/env"

export function obs(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const { metrics, logger } = c.get("services")
    const start = c.get("performanceStart")
    const requestId = c.get("requestId")
    const isolateLifetime = Date.now() - c.get("isolateCreatedAt")

    // Get the wide event logger from context (request-scoped)
    const wideEventLogger = c.get("wideEventLogger")

    try {
      await next()
    } catch (e) {
      wideEventLogger.add("cloud.isolate_lifetime", isolateLifetime)
      wideEventLogger.addError(e)
      throw e
    } finally {
      const status = c.res.status
      const duration = Date.now() - start
      c.res.headers.set("Unprice-Request-Id", requestId)
      c.res.headers.append("Unprice-Latency", `service=${duration}ms`)
      c.res.headers.append("Unprice-Version", c.env.VERSION)

      wideEventLogger.add("request.status", status)
      wideEventLogger.add("request.duration", duration)

      // flush metrics and logger with a timeout so waitUntil completes within
      // Cloudflare's allowed post-response window and we avoid cancellation warnings
      const FLUSH_TIMEOUT_MS = 10_000 // 10 seconds
      c.executionCtx.waitUntil(
        (async () => {
          try {
            await Promise.race([
              Promise.all([
                wideEventLogger.emit(),
                metrics.flush().catch((err: Error) => {
                  console.error("Failed to flush metrics", { error: err.message })
                }),
                logger.flush().catch((err: Error) => {
                  console.error("Failed to flush logger", { error: err.message })
                }),
              ]),
              new Promise<void>((resolve) => setTimeout(() => resolve(), FLUSH_TIMEOUT_MS)),
            ])
          } catch (error) {
            console.error("Error during background flush", error)
          }
        })()
      )
    }
  }
}
