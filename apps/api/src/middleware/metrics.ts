import type { Metric } from "@unprice/metrics"
import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "../hono/env"

type DiscriminateMetric<T, M = Metric> = M extends { metric: T } ? M : never

export function metrics(): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const { metrics, logger } = c.get("services")
    const stats = c.get("stats")
    const start = c.get("performanceStart")

    let requestBody = await c.req.raw.clone().text()
    requestBody = requestBody.replaceAll(/"key":\s*"[a-zA-Z0-9_]+"/g, '"key": "<REDACTED>"')
    requestBody = requestBody.replaceAll(
      /"plaintext":\s*"[a-zA-Z0-9_]+"/g,
      '"plaintext": "<REDACTED>"'
    )
    const m = {
      isolateId: c.get("isolateId"),
      isolateLifetime: Date.now() - c.get("isolateCreatedAt"),
      metric: "metric.http.request",
      path: c.req.path,
      host: new URL(c.req.url).host,
      method: c.req.method,
      continent: stats.continent,
      country: stats.country,
      colo: stats.colo,
      city: stats.city,
      userAgent: stats.ua,
      source: stats.source,
      status: c.res.status,
      duration: performance.now() - start,
      service: "api",
      platform: "cloudflare",
    } as DiscriminateMetric<"metric.http.request">

    try {
      await next()
    } catch (e) {
      m.error = (e as Error).message
      c.get("services").logger.error("request", {
        method: c.req.method,
        path: c.req.path,
        error: e,
      })
      throw e
    } finally {
      m.status = c.res.status
      m.duration = performance.now() - start
      c.res.headers.append("Unprice-Latency", `service=${m.duration}ms`)
      c.res.headers.append("Unprice-Version", c.env.VERSION)

      const responseHeaders: Array<string> = []
      c.res.headers.forEach((v, k) => {
        responseHeaders.push(`${k}: ${v}`)
      })

      let responseBody = await c.res.clone().text()
      responseBody = responseBody.replaceAll(/"key":\s*"[a-zA-Z0-9_]+"/g, '"key": "<REDACTED>"')
      responseBody = responseBody.replaceAll(
        /"plaintext":\s*"[a-zA-Z0-9_]+"/g,
        '"plaintext": "<REDACTED>"'
      )

      c.executionCtx.waitUntil(Promise.all([metrics.emit(m), metrics.flush(), logger.flush()]))
    }
  }
}
