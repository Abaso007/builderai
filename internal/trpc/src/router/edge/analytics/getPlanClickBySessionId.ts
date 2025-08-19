import type { Analytics } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { TIMEOUTS, withTimeout } from "#utils/timeout"

export const getPlanClickBySessionId = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getPlanClickBySessionId"]>[0]>())
  .output(
    z.object({
      planClick: z.custom<Awaited<ReturnType<Analytics["getPlanClickBySessionId"]>>["data"]>(),
    })
  )
  .query(async (opts) => {
    const projectId = opts.ctx.project.id
    const input = opts.input

    try {
      const result = await withTimeout(
        opts.ctx.analytics.getPlanClickBySessionId({
          session_id: input.session_id,
          action: input.action,
        }),
        TIMEOUTS.ANALYTICS,
        "getPlanClickBySessionId analytics request timeout"
      )

      return { planClick: result.data }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"

      opts.ctx.logger.error("getPlanClickBySessionId failed", {
        error: errorMessage,
        projectId,
        isTimeout: errorMessage.includes("timeout"),
      })

      // Return empty data as fallback
      return { planClick: [] }
    }
  })
