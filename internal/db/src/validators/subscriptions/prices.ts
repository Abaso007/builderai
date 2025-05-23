import * as currencies from "@dinero.js/currencies"
import type { Dinero } from "dinero.js"
import { add, dinero, isZero, multiply, toDecimal, trimScale } from "dinero.js"
import { z } from "zod"

import type { Result } from "@unprice/error"
import { Err, Ok, type SchemaError } from "@unprice/error"
import { calculatePercentage, formatMoney } from "../../utils"
import type { PlanVersionExtended } from "../planVersions"
import { type Currency, typeFeatureSchema } from "../shared"
import { UnPriceCalculationError } from "./../errors"
import {
  type PlanVersionFeature,
  configFeatureSchema,
  type dineroSchema,
  type tiersSchema,
} from "./../planVersionFeatures"
import {
  configFlatSchema,
  configPackageSchema,
  configTierSchema,
  configUsageSchema,
  priceSchema,
} from "./../planVersionFeatures"

const calculatePriceSchema = z.object({
  dinero: z.custom<Dinero<number>>(),
  displayAmount: priceSchema,
  hasUsage: z.boolean().optional(),
})

const unitsSchema = z.coerce.number().int().min(0)

export interface CalculatedPrice {
  unitPrice: z.infer<typeof calculatePriceSchema>
  totalPrice: z.infer<typeof calculatePriceSchema>
}

const calculatePricePerFeatureSchema = z.object({
  quantity: unitsSchema,
  featureType: typeFeatureSchema,
  config: configFeatureSchema,
  /**
   * number between 0 and 1 to indicate how much to charge
   * if they have had a fixed cost item for 15/30 days, this should be 0.5
   */
  prorate: z.number().min(0).max(1).optional(),
})

// calculate flat price of the plan based on the features in the plan
export const calculateFlatPricePlan = ({
  planVersion,
  prorate,
}: {
  planVersion: PlanVersionExtended
  prorate?: number
}): Result<z.infer<typeof calculatePriceSchema>, UnPriceCalculationError> => {
  const defaultDineroCurrency = currencies[planVersion.currency]
  let total = dinero({ amount: 0, currency: defaultDineroCurrency })
  let hasUsage = false

  // here we are getting the price of flat features because that determines the plan price
  // the rest of the features depends on quantity and are calculated later
  planVersion.planFeatures.forEach((feature) => {
    // flat features are always quantity 1
    if (["flat"].includes(feature.featureType)) {
      const { val: price, err } = calculatePricePerFeature({
        config: feature.config!,
        featureType: feature.featureType,
        quantity: 1,
        prorate,
      })

      if (err) {
        return Err(err)
      }

      total = add(total, price.totalPrice.dinero)
    }

    if (["usage"].includes(feature.featureType)) {
      hasUsage = true
    }
  })

  const displayAmount = toDecimal(
    total,
    ({ value, currency }) => `${formatMoney(value, currency.code)}`
  )

  return Ok({
    dinero: total,
    displayAmount: displayAmount,
    hasUsage,
  })
}

// calculate the total price of the plan based on the quantities of the features
export const calculateTotalPricePlan = ({
  features,
  quantities,
  prorate,
  currency,
}: {
  features: PlanVersionFeature[]
  quantities: Record<string, number>
  prorate?: number
  currency: Currency
}): Result<z.infer<typeof calculatePriceSchema>, UnPriceCalculationError> => {
  const defaultDineroCurrency = currencies[currency]
  let total = dinero({ amount: 0, currency: defaultDineroCurrency })

  features.forEach((feature) => {
    // flat features are always quantity 1
    if (["flat"].includes(feature.featureType)) {
      const { val: price, err } = calculatePricePerFeature({
        config: feature.config!,
        featureType: feature.featureType,
        quantity: 1,
        prorate,
      })

      if (err) {
        return Err(err)
      }

      total = add(total, price.totalPrice.dinero)
    }

    if (["tier", "package", "usage"].includes(feature.featureType)) {
      const { val: price, err } = calculatePricePerFeature({
        config: feature.config!,
        featureType: feature.featureType,
        quantity: quantities[feature.id] ?? 0,
        prorate,
      })

      if (err) {
        return Err(err)
      }

      total = add(total, price.totalPrice.dinero)
    }
  })

  const displayAmount = toDecimal(
    total,
    ({ value, currency }) => `${formatMoney(value, currency.code)}`
  )

  return Ok({
    dinero: total,
    displayAmount: displayAmount,
  })
}

// calculate the number of free units for a feature
// useful for table pricing and displaying plans
// returns 0 if the feature is paid, Number.POSITIVE_INFINITY if the feature is free
export const calculateFreeUnits = ({
  config,
  featureType,
}: {
  config: z.infer<typeof configFeatureSchema>
  featureType: z.infer<typeof typeFeatureSchema>
}): number => {
  switch (featureType) {
    case "flat": {
      // flat features are free or paid
      const { price } = configFlatSchema.parse(config)

      const { val: priceTotal } = calculateUnitPrice({
        price,
        quantity: 1,
        isUsageBased: false,
      })

      if (priceTotal?.totalPrice.dinero && isZero(priceTotal.totalPrice.dinero)) {
        return Number.POSITIVE_INFINITY
      }

      return 0
    }
    case "tier": {
      const { tiers, tierMode } = configTierSchema.parse(config)
      let total = 0
      for (const tier of tiers) {
        // if limit is infinity, we can't calculate the free units and also means
        // we are in the last tier so return undefined
        const limit = tier.lastUnit ?? tier.firstUnit

        const { val: totalPrice } = calculateTierPrice({
          tiers,
          quantity: limit,
          tierMode,
          isUsageBased: false,
        })

        if (totalPrice?.totalPrice.dinero && isZero(totalPrice.totalPrice.dinero)) {
          // with the last tier still 0 means is free no matter what is the amount
          total = !tier.lastUnit ? Number.POSITIVE_INFINITY : limit
        }
      }
      return total
    }
    case "usage": {
      const { tiers, usageMode, units, price, tierMode } = configUsageSchema.parse(config)

      if (usageMode === "tier" && tierMode && tiers && tiers.length > 0) {
        let total = 0
        for (const tier of tiers) {
          // if limit is infinity, we can't calculate the free units and also means
          // we are in the last tier so return POSITIVE_INFINITY
          const limit = tier.lastUnit ?? tier.firstUnit

          const { val: totalPrice } = calculateTierPrice({
            tiers,
            quantity: limit,
            tierMode,
            isUsageBased: false,
          })

          if (totalPrice?.totalPrice.dinero && isZero(totalPrice.totalPrice.dinero)) {
            // with the last tier still 0 means is free no matter what is the amount
            total = !tier.lastUnit ? Number.POSITIVE_INFINITY : limit
          }
        }
        return total
      }

      if (usageMode === "unit" && price) {
        const { val: priceTotal } = calculateUnitPrice({
          price,
          quantity: 1,
          isUsageBased: false,
        })

        if (priceTotal?.totalPrice.dinero && isZero(priceTotal.totalPrice.dinero)) {
          return Number.POSITIVE_INFINITY
        }

        return 0
      }

      if (usageMode === "package" && units && price) {
        const { val: priceTotal } = calculatePackagePrice({
          price,
          // calculate a price for the whole package
          quantity: units,
          units,
          isUsageBased: false,
        })

        if (priceTotal?.totalPrice.dinero && isZero(priceTotal.totalPrice.dinero)) {
          return Number.POSITIVE_INFINITY
        }

        return 0
      }

      return 0
    }
    case "package": {
      const { units, price } = configPackageSchema.parse(config)

      const { val: priceTotal } = calculatePackagePrice({
        price,
        // calculate a price for the whole package
        quantity: units,
        units,
        isUsageBased: false,
      })

      if (priceTotal?.totalPrice.dinero && isZero(priceTotal.totalPrice.dinero)) {
        return Number.POSITIVE_INFINITY
      }

      return 0
    }
    default:
      return 0
  }
}

export const calculateTierPrice = ({
  tiers,
  quantity,
  tierMode,
  isUsageBased,
  prorate,
}: {
  tiers: z.infer<typeof tiersSchema>[]
  quantity: z.infer<typeof unitsSchema>
  tierMode: z.infer<typeof configTierSchema>["tierMode"]
  isUsageBased: boolean
  prorate?: number
}): Result<CalculatedPrice, UnPriceCalculationError> => {
  // return 0 price if quantity is 0
  if (quantity === 0) {
    const firstTier = tiers[0]! // we are sure that the first tier exists

    // we know the currency is the same for all tiers
    const defaultCurrency = firstTier.unitPrice.dinero.currency.code as keyof typeof currencies

    const total = dinero({
      amount: 0,
      currency: currencies[defaultCurrency],
    })

    return Ok({
      unitPrice: {
        dinero: total,
        displayAmount: toDecimal(total, ({ value, currency }) => {
          if (isUsageBased) {
            return `starts at ${formatMoney(value, currency.code)} per unit`
          }
          return `${formatMoney(value, currency.code)} per unit`
        }),
      },
      totalPrice: {
        dinero: total,
        displayAmount: toDecimal(
          total,
          ({ value, currency }) => `${formatMoney(value, currency.code)}`
        ),
      },
    })
  }

  // here we have to calculate the total price based on the tier mode.
  // tier mode is volume, then all units are priced based on the final tier reached
  if (tierMode === "volume") {
    // find the tier that the quantity falls into
    const tier = tiers.find(
      (tier) => quantity >= tier.firstUnit && (tier.lastUnit === null || quantity <= tier.lastUnit)
    )! // we are sure the quantity falls into a tier

    // flat price needs to be prorated as well
    const dineroFlatPrice =
      prorate !== undefined
        ? trimScale(calculatePercentage(dinero(tier.flatPrice.dinero), prorate))
        : trimScale(dinero(tier.flatPrice.dinero))
    const dineroUnitPrice =
      prorate !== undefined
        ? trimScale(calculatePercentage(dinero(tier.unitPrice.dinero), prorate))
        : trimScale(dinero(tier.unitPrice.dinero))

    const dineroTotalPrice = !isZero(dineroFlatPrice)
      ? trimScale(add(multiply(dinero(tier.unitPrice.dinero), quantity), dineroFlatPrice))
      : trimScale(multiply(dinero(tier.unitPrice.dinero), quantity))

    return Ok({
      unitPrice: {
        dinero: dineroUnitPrice,
        displayAmount: toDecimal(dineroUnitPrice, ({ value, currency }) => {
          const prefix = isUsageBased ? "starts at " : ""
          if (isZero(dineroFlatPrice)) {
            return `${prefix} ${formatMoney(value, currency.code)} per unit`
          }

          return `${prefix} ${formatMoney(
            toDecimal(dineroFlatPrice),
            currency.code
          )} + ${formatMoney(value, currency.code)} per unit`
        }),
      },
      totalPrice: {
        dinero: dineroTotalPrice,
        displayAmount: toDecimal(
          dineroTotalPrice,
          ({ value, currency }) => `${formatMoney(value, currency.code)}`
        ),
      },
    })
  }

  // if the tier mode is graduated, then the tiers applies progressively as quantity increases
  if (tierMode === "graduated") {
    let remaining = quantity // make a copy, so we don't mutate the original

    // find the tier that the quantity falls into
    const tier = tiers.find(
      (tier) => quantity >= tier.firstUnit && (tier.lastUnit === null || quantity <= tier.lastUnit)
    )! // we are sure the quantity falls into a tier

    // we know the currency is the same for all tiers
    const defaultCurrency = tier.unitPrice.dinero.currency.code as keyof typeof currencies
    // initialize the total price as 0
    let total: Dinero<number> = dinero({
      amount: 0,
      currency: currencies[defaultCurrency],
    })

    // iterate through the tiers and calculate the total price
    // for tiered graduated, we need to calculate the price for each tier the quantity falls into
    // and sum them up to get the total price
    // but the flat price is only applied once where the quantity falls into the tier
    for (const tier of tiers) {
      if (remaining <= 0) {
        break
      }

      const quantityCalculation =
        tier.lastUnit === null ? remaining : Math.min(tier.lastUnit - tier.firstUnit + 1, remaining)
      remaining -= quantityCalculation

      const unitPrice = dinero(tier.unitPrice.dinero)
      // multiply the unit price by the quantity calculation
      total = add(total, multiply(unitPrice, quantityCalculation))
    }

    // add the flat price of the tier the quantity falls into if it exists
    if (tier?.flatPrice) {
      // flat price needs to be prorated as well
      const dineroFlatPrice =
        prorate !== undefined
          ? trimScale(calculatePercentage(dinero(tier.flatPrice.dinero), prorate))
          : trimScale(dinero(tier.flatPrice.dinero))
      total = trimScale(add(total, dineroFlatPrice))
    }

    return Ok({
      unitPrice: {
        dinero: dinero(tier.unitPrice.dinero),
        displayAmount: toDecimal(dinero(tier.unitPrice.dinero), ({ value, currency }) => {
          if (isUsageBased) {
            return `starts at ${formatMoney(value, currency.code)} per unit`
          }

          return `${formatMoney(value, currency.code)} per unit`
        }),
      },
      totalPrice: {
        dinero: total,
        displayAmount: toDecimal(
          total,
          ({ value, currency }) => `${formatMoney(value, currency.code)}`
        ),
      },
    })
  }

  return Err(new UnPriceCalculationError({ message: "unknown tier mode" }))
}

export const calculatePackagePrice = ({
  price,
  quantity,
  units,
  isUsageBased,
  prorate,
}: {
  price: z.infer<typeof dineroSchema>
  quantity: z.infer<typeof unitsSchema>
  units: number
  isUsageBased: boolean
  prorate?: number
}): Result<CalculatedPrice, UnPriceCalculationError> => {
  // return 0 price if quantity is 0
  if (quantity === 0) {
    const defaultCurrency = price.dinero.currency.code as keyof typeof currencies

    const total = dinero({
      amount: 0,
      currency: currencies[defaultCurrency],
    })

    return Ok({
      unitPrice: {
        dinero: total,
        displayAmount: toDecimal(total, ({ value, currency }) => {
          if (isUsageBased) {
            return `starts at ${formatMoney(value, currency.code)} per ${units} units`
          }
          return `${formatMoney(value, currency.code)} per ${units} units`
        }),
      },
      totalPrice: {
        dinero: total,
        displayAmount: toDecimal(
          total,
          ({ value, currency }) => `${formatMoney(value, currency.code)}`
        ),
      },
    })
  }

  const packageCount = Math.ceil(quantity / units)
  const dineroPrice = dinero(price.dinero)
  const total =
    prorate !== undefined
      ? trimScale(calculatePercentage(multiply(dineroPrice, packageCount), prorate))
      : trimScale(multiply(dineroPrice, packageCount))

  const unit =
    prorate !== undefined
      ? trimScale(calculatePercentage(dineroPrice, prorate))
      : trimScale(dineroPrice)

  return Ok({
    unitPrice: {
      dinero: unit,
      displayAmount: toDecimal(unit, ({ value, currency }) => {
        if (isUsageBased) {
          return `starts at ${formatMoney(value, currency.code)} per ${units} units`
        }
        return `${formatMoney(value, currency.code)} per ${units} units`
      }),
    },
    totalPrice: {
      dinero: total,
      displayAmount: toDecimal(
        total,
        ({ value, currency }) => `${formatMoney(value, currency.code)}`
      ),
    },
  })
}

export const calculateUnitPrice = ({
  price,
  quantity,
  isUsageBased,
  prorate,
  isFlat = false,
}: {
  price: z.infer<typeof dineroSchema>
  quantity: z.infer<typeof unitsSchema>
  isUsageBased: boolean
  prorate?: number
  isFlat?: boolean
}): Result<CalculatedPrice, UnPriceCalculationError> => {
  const dineroPrice = trimScale(dinero(price.dinero))
  const total =
    prorate !== undefined
      ? trimScale(calculatePercentage(multiply(dineroPrice, quantity), prorate))
      : trimScale(multiply(dineroPrice, quantity))

  const unit =
    prorate !== undefined ? trimScale(calculatePercentage(dineroPrice, prorate)) : dineroPrice

  return Ok({
    unitPrice: {
      dinero: unit,
      displayAmount: toDecimal(unit, ({ value, currency }) => {
        if (isUsageBased) {
          return `starts at ${formatMoney(value, currency.code)} per unit`
        }
        return `${formatMoney(value, currency.code)} ${isFlat ? "" : "per unit"}`
      }),
    },
    totalPrice: {
      dinero: total,
      displayAmount: toDecimal(total, ({ value, currency }) => {
        return `${formatMoney(value, currency.code)}`
      }),
    },
  })
}

export const calculatePricePerFeature = (
  data: z.infer<typeof calculatePricePerFeatureSchema>
): Result<CalculatedPrice, UnPriceCalculationError | SchemaError> => {
  // set default units to 0 if it's not provided
  // proration only applies to fix costs per billing period
  const { config, featureType, quantity, prorate } = data
  const defaultQuantity = quantity || 0

  switch (featureType) {
    case "flat": {
      const { price } = configFlatSchema.parse(config)
      // flat features have a single price independent of the units
      return calculateUnitPrice({ price, quantity: 1, isUsageBased: false, prorate, isFlat: true })
    }

    case "tier": {
      const { tiers, tierMode } = configTierSchema.parse(config)
      return calculateTierPrice({
        tiers,
        quantity: defaultQuantity,
        tierMode,
        isUsageBased: false,
        prorate,
      })
    }

    case "usage": {
      const { tiers, usageMode, units, price, tierMode } = configUsageSchema.parse(config)

      if (usageMode === "tier" && tierMode && tiers && tiers.length > 0) {
        return calculateTierPrice({
          tiers,
          quantity: defaultQuantity,
          tierMode,
          isUsageBased: true,
        })
      }

      if (usageMode === "unit" && price) {
        return calculateUnitPrice({ price, quantity: defaultQuantity, isUsageBased: true })
      }

      if (usageMode === "package" && units && price) {
        return calculatePackagePrice({
          price,
          quantity: defaultQuantity,
          units,
          isUsageBased: true,
        })
      }

      return Err(new UnPriceCalculationError({ message: "unknown usageMode" }))
    }

    case "package": {
      const { units, price } = configPackageSchema.parse(config)

      return calculatePackagePrice({
        price,
        quantity: defaultQuantity,
        units,
        isUsageBased: false,
        prorate,
      })
    }

    default:
      return Err(new UnPriceCalculationError({ message: "unknown feature type" }))
  }
}
