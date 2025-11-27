import type {
  EntitlementState,
  GetCurrentUsage,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import { type BaseError, Ok, type Result } from "@unprice/error"
import type { GetEntitlementsRequest, GetUsageRequest, UsageLimiter } from "./interface"

export class NoopUsageLimiter implements UsageLimiter {
  public async prewarmEntitlements(_params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<void, BaseError>> {
    return Ok(undefined)
  }

  public async verify(_req: VerifyRequest): Promise<Result<VerificationResult, BaseError>> {
    return Ok({ allowed: true, message: "Allowed" })
  }

  public async reportUsage(
    _req: ReportUsageRequest
  ): Promise<Result<ReportUsageResult, BaseError>> {
    return Ok({ allowed: true, message: "Allowed", consumedFrom: [] })
  }

  public async prewarm(_params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<void> {
    return
  }

  public async getActiveEntitlements(
    _req: GetEntitlementsRequest
  ): Promise<Result<EntitlementState[], BaseError>> {
    return Ok([])
  }

  public async getCurrentUsage(_req: GetUsageRequest): Promise<Result<GetCurrentUsage, BaseError>> {
    return Ok({} as GetCurrentUsage)
  }
}
