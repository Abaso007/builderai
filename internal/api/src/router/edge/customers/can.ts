import type { FeatureType } from "@unprice/db/validators"
import { deniedReasonSchema } from "@unprice/services/customers"
import { z } from "zod"
import { protectedApiOrActiveProjectProcedure } from "../../../trpc"
import { verifyEntitlement } from "../../../utils/shared"

export const can = protectedApiOrActiveProjectProcedure
  .meta({
    span: "customers.can",
    openapi: {
      method: "GET",
      path: "/edge/customers.can",
      protect: true,
    },
  })
  .input(
    z.object({
      customerId: z.string(),
      featureSlug: z.string(),
    })
  )
  .output(
    z.object({
      access: z.boolean(),
      deniedReason: deniedReasonSchema.optional(),
      currentUsage: z.number().optional(),
      limit: z.number().optional(),
      featureType: z.custom<FeatureType>().optional(),
      units: z.number().optional(),
    })
  )
  .query(async (opts) => {
    const { customerId, featureSlug } = opts.input
    const { apiKey, ...ctx } = opts.ctx
    const projectId = apiKey.projectId

    return await verifyEntitlement({
      customerId,
      featureSlug,
      projectId: projectId,
      ctx,
    })
  })
