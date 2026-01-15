import { FEATURE_SLUGS } from "@unprice/config"
import type { Context } from "hono"
import type { HonoEnv } from "~/hono/env"

export const reportUsageEvents = async (
  c: Context<HonoEnv>,
  metadata: Record<string, string | undefined>
) => {
  const unPriceCustomerId = c.get("unPriceCustomerId")
  const isInternal = c.get("isInternal")
  const isMain = c.get("isMain")
  const projectId = c.get("projectId")
  const requestId = c.get("requestId")
  const stats = c.get("stats")

  const { usagelimiter, logger } = c.get("services")

  if (!unPriceCustomerId || !projectId) {
    // if not project or customer id most likely is public route so we don't need to report the usage
    return
  }

  // if the project is internal or main, we don't need to report the usage
  if (isInternal || isMain) {
    logger.debug("Skipping usage report for internal or main project", {
      isInternal,
      isMain,
      unPriceCustomerId,
      projectId,
    })
    return
  }

  const { err } = await usagelimiter.reportUsage({
    customerId: unPriceCustomerId,
    featureSlug: FEATURE_SLUGS.EVENTS.SLUG,
    projectId: projectId,
    requestId,
    usage: 1,
    // short ttl for dev
    flushTime: c.env.NODE_ENV === "development" ? 5 : undefined,
    idempotenceKey: `${requestId}:${unPriceCustomerId}`,
    timestamp: Date.now(),
    metadata: {
      ...metadata,
      ip: stats.ip,
      country: stats.country,
      region: stats.region,
      colo: stats.colo,
      city: stats.city,
      latitude: stats.latitude,
      longitude: stats.longitude,
      ua: stats.ua,
      continent: stats.continent,
      source: stats.source,
    },
  })

  if (err) {
    logger.error("Failed to report usage events in the API", {
      error: err,
      customerId: unPriceCustomerId,
      projectId: projectId,
      featureSlug: FEATURE_SLUGS.EVENTS.SLUG,
    })
    return
  }

  return
}
