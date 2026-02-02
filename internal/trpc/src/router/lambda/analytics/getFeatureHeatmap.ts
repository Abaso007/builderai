import type { Analytics, FeatureHeatmap } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getFeatureHeatmap = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getFeatureHeatmap"]>[0]>())
  .output(
    z.object({
      data: z.custom<FeatureHeatmap>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const { interval_days } = opts.input
    const project_id = opts.ctx.project.id

    const cacheKey = `${project_id}:${interval_days}`
    const result = await opts.ctx.cache.getFeatureHeatmap.swr(cacheKey, async () => {
      const result = await opts.ctx.analytics
        .getFeatureHeatmap({
          project_id: opts.ctx.project.id,
          interval_days,
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
