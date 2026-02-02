import type { Analytics, VerificationRegions } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getVerificationRegions = protectedProjectProcedure
  .input(z.custom<Omit<Parameters<Analytics["getFeaturesVerificationRegions"]>[0], "project_id">>())
  .output(
    z.object({
      verifications: z.custom<VerificationRegions>(),
      error: z.string().optional(),
    })
  )
  .query(async (opts) => {
    const project_id = opts.ctx.project.id
    const timezone = opts.ctx.project.timezone
    const input = opts.input

    const cacheKey = `${project_id}:${input.region}:${timezone}:${input.interval_days}`

    const result = await opts.ctx.cache.getVerificationRegions.swr(cacheKey, async () => {
      const result = await opts.ctx.analytics
        .getFeaturesVerificationRegions({
          project_id,
          timezone,
          region: input.region,
          interval_days: input.interval_days,
        })
        .then((res) => res.data)

      return result
    })

    if (result.err) {
      opts.ctx.logger.error(result.err.message, {
        project_id,
        region: input.region,
        interval_days: input.interval_days,
      })

      return { verifications: [], error: result.err.message }
    }

    const verifications = result.val ?? []

    return { verifications }
  })
