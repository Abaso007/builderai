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

    try {
      const data = await opts.ctx.analytics
        .getFeaturesOverview({
          project_id,
          interval_days,
          timezone,
        })
        .then((res) => res.data)

      return { data: data ?? [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch features overview"
      opts.ctx.logger.error(message, {
        project_id,
        interval_days,
      })

      return { data: [], error: message }
    }
  })
