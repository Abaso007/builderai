import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getLakehouseManifest = protectedProjectProcedure
  .input(
    z.object({
      interval: z.enum(["24h", "7d", "30d", "90d"]).optional(),
      sources: z
        .array(z.enum(["usage", "verification", "metadata", "entitlement_snapshot"]))
        .optional(),
      customerId: z.string().optional(),
    })
  )
  .query(async ({ input, ctx }) => {
    void input
    void ctx

    try {
      const manifestFiles: unknown[] = []

      return {
        files: manifestFiles,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch manifest files"
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message,
      })
    }
  })
