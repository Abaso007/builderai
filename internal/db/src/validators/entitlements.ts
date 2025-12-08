import { createInsertSchema, createSelectSchema } from "drizzle-zod"
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

export const grantSchema = createSelectSchema(schema.grants, {
  metadata: entitlementMetadataSchema,
})

export const grantInsertSchema = createInsertSchema(schema.grants, {
  metadata: entitlementMetadataSchema.nullable(),
})

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
  allowOverage: z.boolean(),
  featurePlanVersionId: z.string(),
  // let us keep track in analytics
  subscriptionItemId: z.string().nullable(),
  subscriptionPhaseId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
})

export const entitlementSchema = createSelectSchema(schema.entitlements, {
  metadata: entitlementMetadataSchema,
  grants: entitlementGrantsSnapshotSchema.array(),
  resetConfig: resetConfigSchema.extend({
    resetAnchor: z.number(),
  }),
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
  mergingPolicy: true,
  grants: true,
  version: true,
  computedAt: true,
  currentCycleUsage: true,
  accumulatedUsage: true,
  aggregationMethod: true,
  effectiveAt: true,
  expiresAt: true,
  limit: true,
  resetConfig: true,
  allowOverage: true,
  nextRevalidateAt: true,
  lastSyncAt: true,
})

export type EntitlementState = z.infer<typeof entitlementStateSchema>
export type Grant = z.infer<typeof grantSchema>

// Zod schemas for UsageDisplay
const billingFrequencySchema = z.enum(["daily", "weekly", "monthly", "yearly"])
const limitTypeSchema = z.enum(["hard", "soft", "none"])

const usageBarDisplaySchema = z.object({
  current: z.number(),
  included: z.number(),
  limit: z.number().optional(),
  limitType: limitTypeSchema,
  unit: z.string(),
  notifyThreshold: z.number().optional(),
  allowOverage: z.boolean(),
})

const tierDisplaySchema = z.object({
  min: z.number(),
  max: z.number().nullable(),
  pricePerUnit: z.number(),
  label: z.string().optional(),
  isActive: z.boolean(),
})

const tieredDisplaySchema = z.object({
  currentUsage: z.number(),
  billableUsage: z.number(),
  unit: z.string(),
  freeAmount: z.number(),
  tiers: z.array(tierDisplaySchema),
  currentTierLabel: z.string().optional(),
})

const billingDisplaySchema = z.object({
  hasDifferentBilling: z.boolean(),
  billingFrequency: billingFrequencySchema.optional(),
  billingFrequencyLabel: z.string().optional(),
  resetFrequency: billingFrequencySchema.optional(),
  resetFrequencyLabel: z.string().optional(),
})

const flatFeatureDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal("flat"),
  typeLabel: z.string(),
  currency: z.string(),
  price: z.string(),
  isIncluded: z.boolean(),
  enabled: z.boolean(),
  billing: billingDisplaySchema,
})

const tieredFeatureDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal("tiered"),
  typeLabel: z.string(),
  currency: z.string(),
  price: z.string(),
  isIncluded: z.boolean(),
  billing: z.object({
    hasDifferentBilling: z.boolean(),
  }),
  tieredDisplay: tieredDisplaySchema,
})

const usageFeatureDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.literal("usage"),
  typeLabel: z.string(),
  currency: z.string(),
  price: z.string(),
  isIncluded: z.boolean(),
  billing: billingDisplaySchema,
  usageBar: usageBarDisplaySchema,
})

const featureDisplaySchema = z.discriminatedUnion("type", [
  flatFeatureDisplaySchema,
  tieredFeatureDisplaySchema,
  usageFeatureDisplaySchema,
])

const featureGroupDisplaySchema = z.object({
  id: z.string(),
  name: z.string(),
  featureCount: z.number(),
  features: z.array(featureDisplaySchema),
  totalPrice: z.string(),
})

const priceSummaryDisplaySchema = z.object({
  totalPrice: z.string(),
  basePrice: z.string(),
  usageCharges: z.string(),
  hasUsageCharges: z.boolean(),
  flatTotal: z.string(),
  tieredTotal: z.string(),
  packageTotal: z.string(),
  usageTotal: z.string(),
})

export const currentUsageSchema = z.object({
  planName: z.string(),
  planDescription: z.string().optional(),
  basePrice: z.string(),
  billingPeriod: z.string(),
  billingPeriodLabel: z.string(),
  currency: z.string(),
  renewalDate: z.string().optional(),
  daysRemaining: z.number().optional(),
  groups: z.array(featureGroupDisplaySchema),
  priceSummary: priceSummaryDisplaySchema,
})

export type CurrentUsage = z.infer<typeof currentUsageSchema>
