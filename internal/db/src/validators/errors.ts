import { BaseError } from "@unprice/error"

export class UnPriceCalculationError extends BaseError {
  public readonly retry = false
  public readonly name = UnPriceCalculationError.name

  constructor({ message }: { message: string }) {
    super({
      message: message ?? "",
    })
  }
}

export class UnPriceSubscriptionError extends BaseError {
  public readonly retry = false
  public readonly name = UnPriceSubscriptionError.name

  constructor({ message }: { message: string }) {
    super({
      message: message ?? "",
    })
  }
}
