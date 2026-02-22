import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { env } from "#env"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

const frontendIntervalSchema = z.enum(["24h", "7d", "30d", "90d"])
const filePlanIntervalSchema = z.enum(["1d", "7d", "30d", "90d"])
const filePlanTableSchema = z.enum(["usage", "verification", "metadata", "entitlement_snapshot"])

function toFilePlanInterval(interval: z.infer<typeof frontendIntervalSchema> | undefined) {
  if (!interval) return "30d" as const
  return interval === "24h" ? "1d" : filePlanIntervalSchema.parse(interval)
}

export const getLakehouseFilePlan = protectedProjectProcedure
  .input(
    z.object({
      interval: frontendIntervalSchema.optional(),
      customerId: z.string().optional(),
      tables: z.array(filePlanTableSchema).optional(),
    })
  )
  .query(async ({ input, ctx }) => {
    const projectId = ctx.project.id
    const result = await unprice.lakehouse.getFilePlan({
      projectId,
      customerId: input.customerId,
      tables: input.tables,
      interval: toFilePlanInterval(input.interval),
      targetEnv: env.APP_ENV === "production" ? "prod" : "non_prod",
    })

    if (result.error) {
      throw new TRPCError({
        code: result.error.code === "FETCH_ERROR" ? "INTERNAL_SERVER_ERROR" : result.error.code,
        message: result.error.message,
      })
    }

    return result
  })
