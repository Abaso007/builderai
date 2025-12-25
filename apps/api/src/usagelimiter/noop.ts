import type {
  EntitlementState,
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import type { CurrentUsage } from "@unprice/db/validators"
import { type BaseError, Ok, type Result } from "@unprice/error"
import type { GetEntitlementsRequest, GetUsageRequest, UsageLimiter } from "./interface"

export class NoopUsageLimiter implements UsageLimiter {
  public async resetEntitlements(_params: {
    customerId: string
    projectId: string
  }): Promise<Result<void, BaseError>> {
    return Ok(undefined)
  }

  public async verify(_req: VerifyRequest): Promise<Result<VerificationResult, BaseError>> {
    return Ok({ allowed: true, message: "Allowed" })
  }

  public async reportUsage(
    _req: ReportUsageRequest
  ): Promise<Result<ReportUsageResult, BaseError>> {
    return Ok({ allowed: true, message: "Allowed" })
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

  public async getCurrentUsage(_req: GetUsageRequest): Promise<Result<CurrentUsage, BaseError>> {
    return Ok({
      planName: "No Plan",
      basePrice: 0,
      billingPeriod: "monthly",
      billingPeriodLabel: "mo",
      currency: "USD",
      groups: [],
      priceSummary: {
        totalPrice: 0,
        basePrice: 0,
        usageCharges: 0,
        hasUsageCharges: false,
        flatTotal: 0,
        tieredTotal: 0,
        usageTotal: 0,
        freeGrantsSavings: 0,
        hasFreeGrantsSavings: false,
      },
      renewalDate: undefined,
      daysRemaining: undefined,
    } as unknown as CurrentUsage)
  }
}
