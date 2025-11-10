import {
  type ReportUsageRequest,
  type ReportUsageResult,
  type VerificationResult,
  type VerifyRequest,
  customerEntitlementExtendedSchema,
} from "@unprice/db/validators"
import type { BaseError, Result } from "@unprice/error"
import { z } from "zod"

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

export interface UsageLimiter {
  prewarm(params: { customerId: string; projectId: string; now: number }): Promise<void>
  verify(data: VerifyRequest): Promise<Result<VerificationResult, BaseError>>
  reportUsage(data: ReportUsageRequest): Promise<Result<ReportUsageResult, BaseError>>
}
