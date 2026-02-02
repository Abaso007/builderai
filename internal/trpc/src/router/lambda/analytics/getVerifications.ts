import type { Analytics, Verifications } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getVerifications = protectedProjectProcedure
  .input(z.custom<Parameters<Analytics["getFeaturesVerifications"]>[0]>())
  .output(
    z.object({
      verifications: z.custom<Verifications>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const project_id = opts.ctx.project.id
    const input = opts.input

    const cacheKey = `${project_id}:${input.interval_days}`
    const result = await opts.ctx.cache.getVerifications.swr(cacheKey, async () => {
      const result = opts.ctx.analytics
        .getFeaturesVerifications({
          project_id,
          interval_days: input.interval_days,
        })
        .then((res) => res.data)

      return result
    })

    if (result.err) {
      opts.ctx.logger.error(result.err.message, {
        project_id,
        interval_days: input.interval_days,
      })

      return { verifications: [], error: result.err.message }
    }

    const verifications = result.val ?? []

    return { verifications }
  })
