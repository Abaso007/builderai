import type {
  EntitlementState,
  GetCurrentUsage,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { BaseError, Result } from "@unprice/error"
import { z } from "zod"

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
  verify(data: VerifyRequest): Promise<Result<VerificationResult, BaseError>>
  reportUsage(data: ReportUsageRequest): Promise<Result<ReportUsageResult, BaseError>>
  getEntitlements(data: GetEntitlementsRequest): Promise<Result<EntitlementState[], BaseError>>
  getCurrentUsage(data: GetUsageRequest): Promise<Result<GetCurrentUsage, BaseError>>
  prewarmEntitlements(params: { customerId: string; projectId: string; now: number }): Promise<
    Result<void, BaseError>
  >
}
