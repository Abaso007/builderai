import * as z from "zod"

export type MaybeArray<T> = T | T[]

/**
 * `t` has the format `2021-01-01 00:00:00`
 *
 * If we transform it as is, we get `1609459200000` which is `2021-01-01 01:00:00` due to fun timezone stuff.
 * So we split the string at the space and take the date part, and then parse that.
 */
export const dateToUnixMilli = z
  .string()
  .transform((t) => new Date(t.split(" ").at(0) ?? t).getTime())

export const datetimeToUnixMilli = z.string().transform((t) => new Date(t).getTime())

export const featureVerificationSchemaV1 = z.object({
  projectId: z.string(),
  planVersionFeatureId: z.string(),
  subscriptionItemId: z.string().nullable(),
  subscriptionPhaseId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  entitlementId: z.string(),
  deniedReason: z.string().optional(),
  date: z.number(),
  latency: z.number().optional(),
  featureSlug: z.string(),
  customerId: z.string(),
})

export const featureUsageSchemaV1 = z.object({
  subscriptionItemId: z.string().nullable(),
  subscriptionPhaseId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  entitlementId: z.string(),
  featureSlug: z.string(),
  customerId: z.string(),
  date: z.number(),
  projectId: z.string(),
  planVersionFeatureId: z.string(),
  usage: z.number(),
  createdAt: z.number(),
})

export const auditLogSchemaV1 = z.object({
  workspaceId: z.string(),
  auditLogId: z.string(),
  event: z.string(),
  description: z.string().optional(),
  time: z.number(),
  meta: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  actor: z.object({
    type: z.string(),
    id: z.string(),
    name: z.string().optional(),
    meta: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }),
  resources: z.array(
    z.object({
      type: z.string(),
      id: z.string(),
      name: z.string().optional(),
      meta: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    })
  ),
  context: z.object({
    location: z.string(),
    userAgent: z.string().optional(),
  }),
})

export const analyticApiSchema = z.object({
  action: z.string().min(1, {
    message: "action is required",
  }),
  eventPayload: z.any(),
})

export const payloadEventSchema = z.object({
  event_name: z.string(),
  session_id: z.string(),
  // Stringified json
  payload: z.any(),
})

export const eventSchema = z.object({
  ...payloadEventSchema.shape,
  id: z.string(),
  domain: z.string().optional().default("Unknown"),
  subdomain: z.string().optional().default("Unknown"),
  time: z.number().int(),
  timestamp: z.string().datetime(),
})

export const usageSchema = z.object({
  id: z.string(),
  feature: z.string(),
  metric: z.string(),
  value: z.number(),
  time: z.number().int(),
  timestamp: z.string().datetime(),
  workspaceId: z.string(),
  projectId: z.string(),
})

export type PayloadEventType = z.infer<typeof payloadEventSchema>
