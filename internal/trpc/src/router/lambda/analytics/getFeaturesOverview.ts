import type { Analytics } from "@unprice/analytics"
import type { FeaturesOverview } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getFeaturesOverview = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getFeaturesOverview"]>[0]>())
  .output(
    z.object({
      data: z.custom<FeaturesOverview>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { interval_days } = opts.input
    const project_id = opts.ctx.project.id
    const timezone = opts.ctx.project.timezone

    const cacheKey = `${project_id}:${timezone}:${interval_days}`
    const result = await opts.ctx.cache.getFeaturesOverview.swr(cacheKey, async () => {
      const result = await opts.ctx.analytics
        .getFeaturesOverview({
          project_id,
          interval_days,
          timezone,
        })
        .then((res) => res.data)

      return result
    })

    if (result.err) {
      opts.ctx.logger.error(result.err.message, {
        project_id,
        interval_days,
      })

      return { data: [], error: result.err.message }
    }

    const data = result.val ?? []

    return { data }
  })
