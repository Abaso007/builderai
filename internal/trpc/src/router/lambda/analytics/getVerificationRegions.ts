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

    try {
      const verifications = await opts.ctx.analytics
        .getFeaturesVerificationRegions({
          project_id,
          timezone,
          region: input.region,
          interval_days: input.interval_days,
        })
        .then((res) => res.data)

      return { verifications: verifications ?? [] }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch verification regions"
      opts.ctx.logger.error(message, {
        project_id,
        region: input.region,
        interval_days: input.interval_days,
      })

      return { verifications: [], error: message }
    }
  })
