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

    try {
      const verifications = await opts.ctx.analytics
        .getFeaturesVerifications({
          project_id,
          interval_days: input.interval_days,
        })
        .then((res) => res.data)

      return { verifications: verifications ?? [] }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch verifications"
      opts.ctx.logger.error(message, {
        project_id,
        interval_days: input.interval_days,
      })

      return { verifications: [], error: message }
    }
  })
