import type { MiddlewareHandler } from "hono"
import { getCurrentEvent } from "~/util/observability"
import type { HonoEnv } from "../hono/env"

export function obs(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const { metrics, logger } = c.get("services")
    const start = c.get("performanceStart")
    const isolateId = c.get("isolateId")
    const isolateLifetime = Date.now() - c.get("isolateCreatedAt")
    const stats = c.get("stats")
    const requestId = c.get("requestId")

    // Finalize wide event with status and duration
    const wideEvent = getCurrentEvent()

    try {
      await next()
    } catch (e) {
      wideEvent?.addContext({
        requestId,
        infra: {
          platform: "cloudflare",
          isolateId,
          isolateLifetime,
        },
        geo: {
          colo: stats.colo,
          country: stats.country,
          continent: stats.continent,
          city: stats.city,
          region: stats.region,
          ip: stats.ip,
        },
      })

      wideEvent?.add("error", {
        errorType: e instanceof Error ? e.name : undefined,
        errorMessage: e instanceof Error ? e.message : undefined,
      })
      wideEvent?.add("outcome", "error")
      throw e
    } finally {
      const status = c.res.status
      const duration = performance.now() - start
      c.res.headers.append("Unprice-Latency", `service=${duration}ms`)
      c.res.headers.append("Unprice-Version", c.env.VERSION)

      wideEvent?.add("outcome", status >= 400 ? "error" : "success")
      wideEvent?.add("duration", duration)
      wideEvent?.add("status", status)

      // flush metrics and logger
      c.executionCtx.waitUntil(
        (async () => {
          try {
            await Promise.all([
              wideEvent?.log(),
              metrics.flush().catch((err: Error) => {
                console.error("Failed to flush metrics", { error: err.message })
              }),
              logger.flush().catch((err: Error) => {
                console.error("Failed to flush logger", { error: err.message })
              }),
            ])
          } catch (error) {
            console.error("Error during background flush", error)
          }
        })()
      )
    }
  }
}
