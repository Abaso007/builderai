import { FEATURE_SLUGS } from "@unprice/config"
import type { Context } from "hono"
import type { HonoEnv } from "~/hono/env"

export const reportUsageEvents = async (
  c: Context<HonoEnv>,
  metadata: Record<string, string | undefined>
) => {
  const unPriceCustomerId = c.get("unPriceCustomerId")
  const requestId = c.get("requestId")
  const stats = c.get("stats")

  const { customer, usagelimiter, logger } = c.get("services")

  if (unPriceCustomerId) {
    const { val: unPriceCustomer, err: unPriceCustomerErr } =
      await customer.getCustomer(unPriceCustomerId)

    if (unPriceCustomerErr || !unPriceCustomer) {
      logger.error("Failed to get unprice customer", {
        error: unPriceCustomerErr,
      })
      return
    }

    const shouldNotReportUsage =
      unPriceCustomer.project.workspace.isInternal || unPriceCustomer.project.workspace.isMain

    // if the unprice customer is internal or main, we don't need to report the usage
    if (shouldNotReportUsage) {
      logger.debug("Skipping usage report for unprice customer", {
        unPriceCustomerId,
        shouldNotReportUsage,
      })

      return
    }

    await usagelimiter
      .reportUsage({
        customerId: unPriceCustomer.id,
        featureSlug: FEATURE_SLUGS.EVENTS.SLUG,
        projectId: unPriceCustomer.projectId,
        requestId,
        usage: 1,
        // short ttl for dev
        flushTime: c.env.NODE_ENV === "development" ? 5 : undefined,
        idempotenceKey: `${requestId}:${unPriceCustomer.id}`,
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
      .catch((err) => {
        logger.error("Failed to report usage", err)
      })
  }
}
