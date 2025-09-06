import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import * as schema from "../schema"
import { billingConfigSchema } from "./shared"
import { aggregationMethodSchema, typeFeatureSchema } from "./shared"
import { subscriptionPhaseSelectSchema } from "./subscriptions"

extendZodWithOpenApi(z)

export const customerEntitlementMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)

export const customerEntitlementSchema = createSelectSchema(schema.customerEntitlements, {
  metadata: customerEntitlementMetadataSchema,
})

export const customerEntitlementInsertSchema = createInsertSchema(
  schema.customerEntitlements
).partial({
  id: true,
  projectId: true,
})

export const customerEntitlementExtendedSchema = customerEntitlementSchema.extend({
  featureType: typeFeatureSchema,
  aggregationMethod: aggregationMethodSchema,
  featureSlug: z.string(),
  project: z.object({
    enabled: z.boolean(),
  }),
  customer: z.object({
    active: z.boolean(),
  }),
  subscription: z.object({
    active: z.boolean(),
    currentCycleStartAt: z.number(),
    currentCycleEndAt: z.number(),
  }),
  activePhase: subscriptionPhaseSelectSchema
    .pick({
      startAt: true,
      endAt: true,
      billingAnchor: true,
      trialDays: true,
      trialEndsAt: true,
    })
    .extend({
      billingConfig: billingConfigSchema,
    }),
})

export type CustomerEntitlement = z.infer<typeof customerEntitlementSchema>
export type InsertCustomerEntitlement = z.infer<typeof customerEntitlementInsertSchema>
export type CustomerEntitlementExtended = z.infer<typeof customerEntitlementExtendedSchema>
