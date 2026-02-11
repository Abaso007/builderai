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

    try {
      const data = await opts.ctx.analytics
        .getFeatureHeatmap({
          project_id: opts.ctx.project.id,
          interval_days,
        })
        .then((res) => res.data)

      return { data: data ?? [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch feature heatmap"
      opts.ctx.logger.error(message, {
        project_id,
        interval_days,
      })

      return { data: [], error: message }
    }
  })
