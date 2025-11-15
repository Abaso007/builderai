import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"
import * as schema from "../schema"
import { featureSelectBaseSchema } from "./features"
import { planVersionFeatureSelectBaseSchema } from "./planVersionFeatures"
import { deniedReasonSchema, entitlementMergingPolicySchema, resetConfigSchema } from "./shared"
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

export const reportUsageSchema = z.object({
  customerId: z.string(),
  featureSlug: z.string(),
  usage: z.number(),
  idempotenceKey: z.string(),
  flushTime: z.number().optional(),
  timestamp: z.number(),
  projectId: z.string(),
  sync: z.boolean().optional(),
  requestId: z.string(),
  metadata: z.record(z.string(), z.any()).nullable(),
  fromCache: z
    .boolean()
    .optional()
    .describe(
      "if true will check the entitlement from cache. This will reduce latency for the request but won't have 100% accuracy. If false, the entitlement will be validated synchronously 100% accurate but will have a higher latency"
    ),
})

export const verifySchema = z.object({
  timestamp: z.number(),
  customerId: z.string(),
  featureSlug: z.string(),
  projectId: z.string(),
  requestId: z.string(),
  metadata: z.record(z.string(), z.any()).nullable(),
  flushTime: z.number().optional(),
  performanceStart: z.number(),
  fromCache: z
    .boolean()
    .optional()
    .describe(
      "if true will check the entitlement from cache. This will reduce latency for the request but won't have 100% accuracy. If false, the entitlement will be validated synchronously 100% accurate but will have a higher latency"
    ),
})

export type ReportUsageRequest = z.infer<typeof reportUsageSchema>
export type VerifyRequest = z.infer<typeof verifySchema>

export const verificationResultSchema = z.object({
  allowed: z.boolean(),
  message: z.string().optional(),
  deniedReason: deniedReasonSchema.optional(),
  cacheHit: z.boolean().optional(),
  remaining: z.number().optional(),
  limit: z.number().optional(),
  usage: z.number().optional(),
  latency: z.number().optional(),
})
export type VerificationResult = z.infer<typeof verificationResultSchema>

export const consumptionSchema = z.object({
  grantId: z.string(),
  amount: z.number(),
  priority: z.number(),
  type: z.string(),
  featurePlanVersionId: z.string(),
  subscriptionItemId: z.string().nullable(),
  subscriptionPhaseId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
})
export type Consumption = z.infer<typeof consumptionSchema>

export const reportUsageResultSchema = z.object({
  allowed: z.boolean(),
  message: z.string().optional(),
  limit: z.number().optional(),
  usage: z.number().optional(),
  notifiedOverLimit: z.boolean().optional(),
  deniedReason: deniedReasonSchema.optional(),
  consumedFrom: consumptionSchema.array(),
})
export type ReportUsageResult = z.infer<typeof reportUsageResultSchema>

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
  featurePlanVersionId: z.string(),
  // let us keep track in analytics
  subscriptionItemId: z.string().nullable(),
  subscriptionPhaseId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
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

export type EntitlementState = z.infer<typeof entitlementStateSchema>
export type Grant = z.infer<typeof grantSchema>
