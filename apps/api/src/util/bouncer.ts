import type { Context } from "hono"
import { endTime, startTime } from "hono/timing"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

/**
 * Bouncer checks if the customer is blocked by the usage limiter
 * @param c - The context
 * @param customerId - The customer ID
 * @param projectId - The project ID
 * @returns True if the customer is blocked, false otherwise
 */
export const bouncer = async (c: Context<HonoEnv>, customerId: string, projectId: string) => {
  const { usagelimiter } = c.get("services")

  // start a new timer for bouncer, this is a quick check so we can return a 403 early
  // in case the customer is blocked by the usage limiter
  startTime(c, "bouncer")

  // Check a "Kill Switch" flag in cache (Edge-cached, ~0-10ms latency)
  const isBlocked = await usagelimiter.isCustomerBlocked({
    customerId,
    projectId,
    now: Date.now(),
  })

  endTime(c, "bouncer")

  if (isBlocked) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: "Your UnPrice API limit has been reached. Please upgrade to continue.",
    })
  }
}
