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

    const data = await opts.ctx.analytics
      .getFeaturesUsagePeriod({
        project_id,
        interval_days,
      })
      .then((res) => res.data)

    return { usage: data }
  })
