import type { z } from "zod"

import type { deniedReasonSchema } from "@unprice/db/validators"
import { BaseError } from "@unprice/error"

export type DenyReason = z.infer<typeof deniedReasonSchema>

export class UnPriceCustomerError extends BaseError<{ customerId?: string }> {
  public readonly retry = false
  public readonly name = UnPriceCustomerError.name
  public readonly code: DenyReason

  constructor({
    code,
    customerId,
    message,
  }: {
    code: DenyReason
    customerId?: string
    message?: string
  }) {
    super({
      message: message ?? "",
      context: {
        customerId,
      },
    })
    this.code = code
  }
}
