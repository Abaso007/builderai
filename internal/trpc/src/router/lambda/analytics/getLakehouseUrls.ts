import { LakehouseService } from "@unprice/analytics"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const lakehouse = new LakehouseService()

export const getLakehouseUrls = protectedProjectProcedure
  .input(
    z.object({
      from: z.number(),
      to: z.number(),
    })
  )
  .query(async ({ input, ctx }) => {
    const { from, to } = input
    const projectId = ctx.project.id

    const fromDate = new Date(from)
    const toDate = new Date(to)

    return lakehouse.getSignedUrls(projectId, fromDate, toDate)
  })
