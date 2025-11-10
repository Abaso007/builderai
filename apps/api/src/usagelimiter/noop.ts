import type {
  ReportUsageRequest,
  ReportUsageResult,
  VerificationResult,
  VerifyRequest,
} from "@unprice/db/validators"
import { type BaseError, Ok, type Result } from "@unprice/error"
import type { UsageLimiter } from "./interface"

export class NoopUsageLimiter implements UsageLimiter {
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
}
