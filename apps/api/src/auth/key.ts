import { SchemaError } from "@unprice/error"
import type { Context } from "hono"
import { endTime, startTime } from "hono/timing"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

/**
 * keyAuth takes the bearer token from the request and verifies the key
 *
 * if the key doesnt exist, isn't valid or isn't a root key, an error is thrown, which gets handled
 * automatically by hono
 */
export async function keyAuth(c: Context<HonoEnv>) {
  const authorization = c.req.header("authorization")?.replace("Bearer ", "")

  if (!authorization) {
    throw new UnpriceApiError({ code: "UNAUTHORIZED", message: "key required" })
  }

  const { apikey } = c.get("services")

  // start timer
  startTime(c, "verifyApiKey")

  // quick off in parallel (reducing p95 latency)
  const [rateLimited, verifyRes] = await Promise.all([
    apikey.rateLimit({
      key: authorization,
      workspaceId: c.get("workspaceId") as string,
      source: "cloudflare",
      limiter: c.env.RL_FREE_600_60s,
    }),
    apikey.verifyApiKey({ key: authorization }),
  ])

  // end timer
  endTime(c, "verifyApiKey")

  if (!rateLimited) {
    throw new UnpriceApiError({ code: "RATE_LIMITED", message: "apikey rate limit exceeded" })
  }

  const { val: key, err } = verifyRes

  if (err) {
    switch (true) {
      case err instanceof SchemaError:
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message: err.message,
        })
    }
    throw new UnpriceApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: err.message,
    })
  }

  if (!key) {
    throw new UnpriceApiError({
      code: "UNAUTHORIZED",
      message: "key not found",
    })
  }

  c.set("workspaceId", key.project.workspaceId)
  c.set("projectId", key.project.id)
  c.set("unPriceCustomerId", key.project.workspace.unPriceCustomerId)

  return key
}
