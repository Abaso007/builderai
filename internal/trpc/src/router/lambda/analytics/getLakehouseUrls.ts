import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const getLakehouseUrls = protectedProjectProcedure
  .input(
    z.object({
      interval: z.enum(["24h", "7d", "30d", "90d"]),
    })
  )
  .query(async ({ input, ctx }) => {
    const { interval } = input
    const projectId = ctx.project.id
    const customerId = ctx.project.workspace.unPriceCustomerId

    const result = await unprice.lakehouse.getManifest({
      customer_id: "cus_11TBEBHiFG4My5qwyLinv6",
      project_id: "proj_11STWG6AokEni2F3eQugHb",
      range: interval,
    })

    if (result.error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error.message })
    }

    console.log(result)

    return result
  })
