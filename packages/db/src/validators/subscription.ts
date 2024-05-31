import * as currencies from "@dinero.js/currencies"
import type { Dinero } from "dinero.js"
import { add, dinero, isZero, multiply, toDecimal } from "dinero.js"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import type { Result } from "@builderai/error"
import { Err, Ok, SchemaError } from "@builderai/error"

import { subscriptions } from "../schema/subscriptions"
import { UnPriceCalculationError } from "./errors"
import type { PlanVersionExtended } from "./planVersionFeatures"
import {
  configFlatSchema,
  configPackageSchema,
  configTierSchema,
  configUsageSchema,
  planVersionExtendedSchema,
  planVersionFeatureInsertBaseSchema,
  priceSchema,
} from "./planVersionFeatures"
import type { Currency, FeatureVersionType } from "./shared"
import {
  currencySymbol,
  subscriptionTypeSchema,
  typeFeatureSchema,
} from "./shared"

export const subscriptionMetadataSchema = z.object({
  externalId: z.string().optional(),
  defaultPaymentMethodId: z.string().optional(),
})

const itemConfigSubscriptionSchema = z.object({
  itemType: typeFeatureSchema,
  // quantity for the item, for flat features it's always 1, usage features it's the current usage
  quantity: z.coerce.number().min(1).optional(),
  // min quantity for the item
  min: z.coerce.number().optional(),
  // limit for the item if any
  limit: z.coerce.number().optional(),
  itemId: z.string(),
  slug: z.string(),
  // current usage for the item in the current billing period
  usage: z.coerce.number().min(0).optional(),
})

// stripe won't allow more than 250 items in a single invoice
export const subscriptionItemsSchema = z
  .array(itemConfigSubscriptionSchema)
  .superRefine((items, ctx) => {
    if (items.length > 50) {
      // TODO: add a better message and map to the correct path
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Total items for the subscription should be less than 50",
        path: ["."],
        fatal: true,
      })

      return false
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      if (item?.quantity && item.limit && item.quantity > item.limit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `limit is ${item.limit}`,
          path: [i, "quantity"],
          fatal: true,
        })

        return false
      }

      if (item?.quantity && item.min && item.quantity < item.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `min is ${item.min}`,
          path: [i, "quantity"],
          fatal: true,
        })

        return false
      }
    }

    return true
  })
  .refine((items) => {
    if (items.length > 250) {
      return false
    }
    return true
  }, "Total items for the subscription should be less than 250")

export const subscriptionSelectSchema = createSelectSchema(subscriptions, {
  metadata: subscriptionMetadataSchema,
  items: subscriptionItemsSchema,
  type: subscriptionTypeSchema,
})

export const subscriptionInsertSchema = createInsertSchema(subscriptions, {
  planVersionId: z.string().min(1, { message: "Plan version is required" }),
  startDate: z.coerce.date({ message: "Start date is required" }),
  trialDays: z.coerce.number().int().min(0).default(0),
  metadata: subscriptionMetadataSchema,
  items: subscriptionItemsSchema,
  type: subscriptionTypeSchema,
})
  .omit({
    createdAt: true,
    updatedAt: true,
  })
  .partial({
    id: true,
    projectId: true,
  })
  .required({
    customerId: true,
    planVersionId: true,
    type: true,
  })

export const subscriptionExtendedSchema = subscriptionSelectSchema
  .pick({
    id: true,
    planVersionId: true,
    customerId: true,
    status: true,
    items: true,
    metadata: true,
  })
  .extend({
    planVersion: planVersionExtendedSchema,
  })

export type Subscription = z.infer<typeof subscriptionSelectSchema>
export type InsertSubscription = z.infer<typeof subscriptionInsertSchema>
export type SubscriptionItem = z.infer<typeof itemConfigSubscriptionSchema>
export type SubscriptionExtended = z.infer<typeof subscriptionExtendedSchema>

export const createDefaultSubscriptionConfig = ({
  planVersion,
  type,
}: {
  planVersion: PlanVersionExtended
  type: FeatureVersionType
}): Result<SubscriptionItem[], UnPriceCalculationError> => {
  if (!planVersion.planFeatures || planVersion.planFeatures.length === 0) {
    return Err(
      new UnPriceCalculationError({
        message: "Plan version does not have any features",
      })
    )
  }
  const itemsConfig = planVersion.planFeatures
    .filter((f) => f.type === type)
    .map((planFeature) => {
      switch (planFeature.featureType) {
        case "flat":
          return {
            itemType: planFeature.featureType,
            itemId: planFeature.id,
            slug: planFeature.feature.slug,
            quantity: 1,
            limit: 1,
            min: 1,
          } as SubscriptionItem
        case "tier": {
          return {
            itemType: planFeature.featureType,
            itemId: planFeature.id,
            slug: planFeature.feature.slug,
            quantity: planFeature.defaultQuantity ?? 1,
            min: 1,
            limit: planFeature.limit,
          } as SubscriptionItem
        }
        case "usage":
          return {
            itemType: planFeature.featureType,
            itemId: planFeature.id,
            slug: planFeature.feature.slug,
            usage: 0,
            limit: planFeature.limit,
          } as SubscriptionItem

        case "package": {
          const config = configPackageSchema.parse(planFeature.config)
          return {
            itemType: planFeature.featureType,
            itemId: planFeature.id,
            slug: planFeature.feature.slug,
            quantity: config.units,
            limit: config.units,
            min: config.units,
          } as SubscriptionItem
        }

        default:
          return {
            itemType: planFeature.featureType,
            itemId: planFeature.id,
            slug: planFeature.feature.slug,
            quantity: planFeature.defaultQuantity,
            limit: planFeature.defaultQuantity,
            min: 1,
          } as SubscriptionItem
      }
    })

  return Ok(itemsConfig)
}

const calculatePriceSchema = z.object({
  dinero: z.custom<Dinero<number>>(),
  displayAmount: priceSchema,
})

interface CalculatedPrice {
  unitPrice: z.infer<typeof calculatePriceSchema>
  totalPrice: z.infer<typeof calculatePriceSchema>
}

const calculatePricePerFeatureSchema = itemConfigSubscriptionSchema
  .pick({ quantity: true })
  .extend({
    feature: planVersionFeatureInsertBaseSchema,
  })

export const calculatePricePerFeature = (
  data: z.infer<typeof calculatePricePerFeatureSchema>
): Result<CalculatedPrice, UnPriceCalculationError | SchemaError> => {
  const parseData = calculatePricePerFeatureSchema.safeParse(data)

  if (!parseData.success) {
    return Err(SchemaError.fromZod(parseData.error, data))
  }

  // set default quantity to 0 if it's not provided
  const { feature, quantity } = parseData.data
  const defaultQuantity = Math.max(1, quantity ?? 0)

  switch (feature.featureType) {
    // flat features have a single price independent of the quantity
    case "flat": {
      const { price: data } = configFlatSchema.parse(feature.config)
      const dineroPrice = dinero(data.dinero)
      const displayAmount = toDecimal(
        dineroPrice,
        ({ value, currency }) =>
          `${currencySymbol(currency.code as Currency)}${value}`
      )

      return Ok({
        unitPrice: {
          dinero: dineroPrice,
          displayAmount: displayAmount,
        },
        totalPrice: {
          dinero: dineroPrice,
          displayAmount: displayAmount,
        },
      })
    }

    case "tier": {
      const { tiers } = configTierSchema.parse(feature.config)

      // find the tier that the quantity falls into
      const tier =
        tiers.find(
          (tier) =>
            defaultQuantity >= tier.firstUnit &&
            (tier.lastUnit === null || defaultQuantity <= tier.lastUnit)
        ) ?? tiers[0]!

      const dineroFlatPrice = dinero(tier.flatPrice.dinero)
      const dineroUnitPrice = dinero(tier.unitPrice.dinero)
      const dineroTotalPrice = !isZero(dineroFlatPrice)
        ? add(
            multiply(dinero(tier.unitPrice.dinero), defaultQuantity),
            dineroFlatPrice
          )
        : multiply(dinero(tier.unitPrice.dinero), defaultQuantity)

      return Ok({
        unitPrice: {
          dinero: dineroUnitPrice,
          displayAmount: toDecimal(dineroUnitPrice, ({ value, currency }) => {
            if (isZero(dineroFlatPrice)) {
              return `${currencySymbol(currency.code as Currency)}${value}`
            } else {
              return `${currencySymbol(currency.code as Currency)}${toDecimal(dineroFlatPrice)} + ${currencySymbol(currency.code as Currency)}${value} per unit`
            }
          }),
        },
        totalPrice: {
          dinero: dineroTotalPrice,
          displayAmount: toDecimal(
            dineroTotalPrice,
            ({ value, currency }) =>
              `${currencySymbol(currency.code as Currency)}${value}`
          ),
        },
      })
    }

    case "usage": {
      const { tiers, usageMode, units, price } = configUsageSchema.parse(
        feature.config
      )

      if (usageMode === "tier" && tiers && tiers.length > 0) {
        let remaining = defaultQuantity // make a copy, so we don't mutate the original

        // find the tier that the quantity falls into
        const tier =
          tiers.find(
            (tier) =>
              defaultQuantity >= tier.firstUnit &&
              (tier.lastUnit === null || defaultQuantity <= tier.lastUnit)
          ) ?? tiers[0]!

        // we know the currency is the same for all tiers
        const defaultCurrency = tier.unitPrice.dinero.currency
          .code as keyof typeof currencies
        // initialize the total price as 0
        let total: Dinero<number> = dinero({
          amount: 0,
          currency: currencies[defaultCurrency],
        })

        // iterate through the tiers and calculate the total price
        // for tiered usage, we need to calculate the price for each tier the quantity falls into
        // and sum them up to get the total price
        // but the flat price is only applied once where the quantity falls into the tier
        for (const tier of tiers) {
          if (remaining <= 0) {
            break
          }

          const quantityCalculation =
            tier.lastUnit === null
              ? remaining
              : Math.min(tier.lastUnit - tier.firstUnit + 1, remaining)
          remaining -= quantityCalculation

          const unitPrice = dinero(tier.unitPrice.dinero)
          total = add(total, multiply(unitPrice, quantityCalculation))
        }

        // add the flat price if it exists
        tier?.flatPrice && (total = add(total, dinero(tier.flatPrice.dinero)))

        return Ok({
          unitPrice: {
            dinero: dinero(tier.unitPrice.dinero),
            displayAmount: toDecimal(
              dinero(tier.unitPrice.dinero),
              ({ value, currency }) =>
                `starts at ${currencySymbol(currency.code as Currency)}${value} per unit`
            ),
          },
          totalPrice: {
            dinero: total,
            displayAmount: toDecimal(
              total,
              ({ value, currency }) =>
                `${currencySymbol(currency.code as Currency)}${value}`
            ),
          },
        })
      }

      if (usageMode === "unit" && price) {
        const dineroPrice = dinero(price.dinero)
        const total = multiply(dineroPrice, defaultQuantity)

        return Ok({
          unitPrice: {
            dinero: dineroPrice,
            displayAmount: toDecimal(
              dineroPrice,
              ({ value, currency }) =>
                `${currencySymbol(currency.code as Currency)}${value} per unit`
            ),
          },
          totalPrice: {
            dinero: total,
            displayAmount: toDecimal(
              total,
              ({ value, currency }) =>
                `${currencySymbol(currency.code as Currency)}${value}`
            ),
          },
        })
      }

      if (usageMode === "package" && units && price) {
        // round up to the next package
        const packageCount = Math.ceil(defaultQuantity / units)

        const dineroPrice = dinero(price.dinero)
        const total = multiply(dineroPrice, packageCount)

        return Ok({
          unitPrice: {
            dinero: dineroPrice,
            displayAmount: toDecimal(
              dineroPrice,
              ({ value, currency }) =>
                `${currencySymbol(currency.code as Currency)}${value} per ${units} unit`
            ),
          },
          totalPrice: {
            dinero: total,
            displayAmount: toDecimal(
              total,
              ({ value, currency }) =>
                `${currencySymbol(currency.code as Currency)}${value}`
            ),
          },
        })
      }

      return Err(
        new UnPriceCalculationError({ message: "unknown feature type usage" })
      )
    }

    case "package": {
      const { units, price } = configPackageSchema.parse(feature.config)

      const defaultQuantity = Math.max(1, quantity ?? 0)

      // round up to the next package
      const packageCount = Math.ceil(defaultQuantity / units)

      const dineroPrice = dinero(price.dinero)
      const total = multiply(dineroPrice, packageCount)

      return Ok({
        unitPrice: {
          dinero: dineroPrice,
          displayAmount: toDecimal(
            dineroPrice,
            ({ value, currency }) =>
              `${currencySymbol(currency.code as Currency)}${value} per ${units} units`
          ),
        },
        totalPrice: {
          dinero: total,
          displayAmount: toDecimal(
            total,
            ({ value, currency }) =>
              `${currencySymbol(currency.code as Currency)}${value}`
          ),
        },
      })
    }

    default:
      return Err(
        new UnPriceCalculationError({ message: "unknown feature type" })
      )
  }
}
