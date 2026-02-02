import type { Analytics, Usage } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getUsage = protectedProjectProcedure
  .input(z.custom<Omit<Parameters<Analytics["getFeaturesUsagePeriod"]>[0], "project_id">>())
  .output(
    z.object({
      usage: z.custom<Usage>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const project_id = opts.ctx.project.id
    const { interval_days } = opts.input

    const cacheKey = `${project_id}:${interval_days}`
    const result = await opts.ctx.cache.getUsage.swr(cacheKey, async () => {
      const result = await opts.ctx.analytics
        .getFeaturesUsagePeriod({
          project_id,
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

      return { usage: [], error: result.err.message }
    }

    const usage = result.val ?? []

    return { usage }
  })
