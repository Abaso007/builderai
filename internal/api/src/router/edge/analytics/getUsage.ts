import { z } from "zod"

import { protectedApiOrActiveProjectProcedure } from "#trpc"

export const getUsage = protectedApiOrActiveProjectProcedure
  .input(
    z.object({
      projectId: z.string().optional(),
      customerId: z.string().optional(),
      featureSlug: z.string().optional(),
      entitlementId: z.string().optional(),
      start: z.number().optional(),
      end: z.number().optional(),
    })
  )
  .output(
    z.object({
      usage: z
        .object({
          projectId: z.string(),
          customerId: z.string(),
          featureSlug: z.string(),
          entitlementId: z.string(),
          count: z.number(),
          sum: z.number(),
          max: z.number(),
          last_during_period: z.number(),
        })
        .array(),
    })
  )
  .query(async (opts) => {
    const data = await opts.ctx.analytics
      .getFeaturesUsage({
        projectId: opts.input.projectId,
        customerId: opts.input.customerId,
        featureSlug: opts.input.featureSlug,
        entitlementId: opts.input.entitlementId,
        start: opts.input.start,
        end: opts.input.end,
      })
      .catch((err) => {
        opts.ctx.logger.error(err)

        return {
          data: [],
        }
      })

    return {
      usage: data.data,
    }
  })
