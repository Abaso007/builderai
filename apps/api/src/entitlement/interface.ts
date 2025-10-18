import { customerEntitlementExtendedSchema, deniedReasonSchema } from "@unprice/db/validators"
import { z } from "zod"

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
  metadata: z.record(z.string(), z.any()).optional(),
})

export const canSchema = z.object({
  timestamp: z.number(),
  customerId: z.string(),
  featureSlug: z.string(),
  projectId: z.string(),
  requestId: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
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
export type CanRequest = z.infer<typeof canSchema>

export const canResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  deniedReason: deniedReasonSchema.optional(),
  cacheHit: z.boolean().optional(),
  remaining: z.number().optional(),
  limit: z.number().optional(),
  usage: z.number().optional(),
  latency: z.number().optional(),
})
export type CanResponse = z.infer<typeof canResponseSchema>

export const reportUsageResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  limit: z.number().optional(),
  usage: z.number().optional(),
  notifyUsage: z.boolean().optional(),
  deniedReason: deniedReasonSchema.optional(),
  cacheHit: z.boolean().optional(),
})
export type ReportUsageResponse = z.infer<typeof reportUsageResponseSchema>

export const getEntitlementsResponseSchema = z.object({
  entitlements: customerEntitlementExtendedSchema.array(),
})

export type GetEntitlementsResponse = z.infer<typeof getEntitlementsResponseSchema>

export const getEntitlementsRequestSchema = z.object({
  customerId: z.string(),
  projectId: z.string(),
  now: z.number(),
})
export type GetEntitlementsRequest = z.infer<typeof getEntitlementsRequestSchema>

export const getUsageRequestSchema = z.object({
  customerId: z.string(),
  projectId: z.string(),
  now: z.number(),
})
export type GetUsageRequest = z.infer<typeof getUsageRequestSchema>
