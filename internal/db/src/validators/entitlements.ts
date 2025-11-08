import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import * as schema from "../schema"
import { featureSelectBaseSchema } from "./features"
import { planVersionFeatureSelectBaseSchema } from "./planVersionFeatures"
import { billingConfigSchema, entitlementMergingPolicySchema, resetConfigSchema } from "./shared"
import { aggregationMethodSchema, typeFeatureSchema } from "./shared"
import {
  subscriptionItemsSelectSchema,
  subscriptionPhaseSelectSchema,
  subscriptionSelectSchema,
} from "./subscriptions"

extendZodWithOpenApi(z)

export const customerEntitlementMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)

export const entitlementMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)

export const grantSchema = createSelectSchema(schema.grants)
export const grantSchemaExtended = grantSchema.extend({
  featurePlanVersion: planVersionFeatureSelectBaseSchema.extend({
    feature: featureSelectBaseSchema,
  }),
  subscriptionItem: subscriptionItemsSelectSchema
    .extend({
      subscription: subscriptionSelectSchema.extend({
        phase: subscriptionPhaseSelectSchema,
      }),
    })
    .optional(),
})

export const entitlementGrantsSnapshotSchema = z.object({
  id: z.string(),
  type: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  priority: z.number(),
  effectiveAt: z.number(),
  expiresAt: z.number().nullable(),
  limit: z.number().nullable(),
  realtime: z.boolean(),
  hardLimit: z.boolean(),
  // let us keep track in analytics
  subscriptionItemId: z.string().optional(),
  subscriptionPhaseId: z.string().optional(),
  subscriptionId: z.string().optional(),
})

export const entitlementSchema = createSelectSchema(schema.entitlements, {
  metadata: entitlementMetadataSchema,
  grants: entitlementGrantsSnapshotSchema.array(),
  resetConfig: resetConfigSchema,
  aggregationMethod: aggregationMethodSchema,
  featureType: typeFeatureSchema,
  mergingPolicy: entitlementMergingPolicySchema,
})

export const entitlementStateSchema = entitlementSchema.pick({
  id: true,
  customerId: true,
  projectId: true,
  featureSlug: true,
  featureType: true,
  effectiveAt: true,
  expiresAt: true,
  mergingPolicy: true,
  grants: true,
  version: true,
  computedAt: true,
  currentCycleUsage: true,
  accumulatedUsage: true,
  aggregationMethod: true,
  limit: true,
  resetConfig: true,
  hardLimit: true,
  nextRevalidateAt: true,
  lastSyncAt: true,
  timezone: true,
})

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
      trialUnits: true,
      trialEndsAt: true,
    })
    .extend({
      billingConfig: billingConfigSchema,
    }),
})

export type CustomerEntitlement = z.infer<typeof customerEntitlementSchema>
export type InsertCustomerEntitlement = z.infer<typeof customerEntitlementInsertSchema>
export type CustomerEntitlementExtended = z.infer<typeof customerEntitlementExtendedSchema>
export type EntitlementState = z.infer<typeof entitlementStateSchema>
