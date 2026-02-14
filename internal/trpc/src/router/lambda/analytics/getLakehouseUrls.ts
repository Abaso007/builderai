import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const getLakehouseUrls = protectedProjectProcedure
  .input(
    z.object({
      interval: z.enum(["24h", "7d", "30d", "90d"]).optional(),
    })
  )
  .query(async ({ input, ctx }) => {
    void input
    const projectId = ctx.project.id

    const result = await unprice.lakehouse.getCatalogCredentials({
      projectId,
      durationSeconds: 3600,
    })

    if (result.error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error.message })
    }

    return result
  })
