import { dinero, toDecimal } from "dinero.js"
import { describe, expect, it } from "vitest"

import * as currencies from "@dinero.js/currencies"
import type { Feature } from "../features"
import type { PlanVersionFeature } from "../planVersionFeatures"
import type { PlanVersionExtended } from "../planVersions"
import type { BillingConfig } from "../shared"
import {
  calculateFlatPricePlan,
  calculatePackagePrice,
  calculateTierPrice,
  calculateTotalPricePlan,
  calculateUnitPrice,
} from "./prices"

describe("pricing calculators", () => {
  it("calculateUnitPrice: applies proration to total (and unit) and keeps subtotal unprorated", () => {
    const price = dinero({ amount: 250, currency: currencies.USD }) // $2.50

    const { val, err } = calculateUnitPrice({
      price: { dinero: price.toJSON(), displayAmount: "2.50" },
      quantity: 4,
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("10.00") // 2.5 * 4
    expect(toDecimal(val!.totalPrice.dinero)).toBe("5.00") // proration 50%
  })

  it("calculatePackagePrice: multiplies by ceil(quantity/units) and prorates total only", () => {
    const price = dinero({ amount: 1000, currency: currencies.USD }) // $10 per package of 5

    const { val, err } = calculatePackagePrice({
      price: { dinero: price.toJSON(), displayAmount: "10.00" },
      quantity: 7,
      units: 5,
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    // ceil(7/5) = 2 packages => subtotal $20, total $10 with 50% proration
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("20.00")
    expect(toDecimal(val!.totalPrice.dinero)).toBe("10.00")
  })

  it("calculateTierPrice volume: subtotal includes full flat fee, total includes prorated flat fee", () => {
    const unitPrice = dinero({ amount: 200, currency: currencies.USD }) // $2
    const flatPrice = dinero({ amount: 1000, currency: currencies.USD }) // $10 flat

    const { val, err } = calculateTierPrice({
      tiers: [
        {
          unitPrice: { dinero: unitPrice.toJSON(), displayAmount: "2.00" },
          flatPrice: { dinero: flatPrice.toJSON(), displayAmount: "10.00" },
          firstUnit: 1,
          lastUnit: null,
        },
      ],
      quantity: 3,
      tierMode: "volume",
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    // subtotal: 3*2 + 10 = 16
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("16.00")
    // total: 3*2 + (10 * 0.5) = 11
    expect(toDecimal(val!.totalPrice.dinero)).toBe("11.00")
  })

  it("calculateTierPrice graduated: accumulates across tiers and applies flat fee (prorated) on the tier reached", () => {
    const t1Unit = dinero({ amount: 200, currency: currencies.USD }) // $2
    const t2Unit = dinero({ amount: 100, currency: currencies.USD }) // $1
    const t2Flat = dinero({ amount: 300, currency: currencies.USD }) // $3

    const { val, err } = calculateTierPrice({
      tiers: [
        {
          unitPrice: { dinero: t1Unit.toJSON(), displayAmount: "2.00" },
          flatPrice: {
            dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
            displayAmount: "0.00",
          },
          firstUnit: 1,
          lastUnit: 5,
        },
        {
          unitPrice: { dinero: t2Unit.toJSON(), displayAmount: "1.00" },
          flatPrice: { dinero: t2Flat.toJSON(), displayAmount: "3.00" },
          firstUnit: 6,
          lastUnit: null,
        },
      ],
      quantity: 7,
      tierMode: "graduated",
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    // per-unit: (1..5)*$2 => $10, (6..7)*$1 => $2 => total units $12
    // subtotal adds full flat fee of reached tier2: 12 + 3 = 15
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("15.00")
    // total prorates the flat fee: 12 + 1.5 = 13.5
    expect(toDecimal(val!.totalPrice.dinero)).toBe("13.50")
  })

  it("calculateTotalPricePlan: sums different feature types", () => {
    const unit = dinero({ amount: 500, currency: currencies.USD }) // $5
    const flat = dinero({ amount: 1000, currency: currencies.USD }) // $10

    const features = [
      {
        id: "f-flat",
        featureType: "flat" as const,
        config: {
          price: { dinero: flat.toJSON(), displayAmount: "10.00" },
        },
      },
      {
        id: "f-tier",
        featureType: "tier" as const,
        config: {
          tierMode: "volume",
          tiers: [
            {
              unitPrice: { dinero: unit.toJSON(), displayAmount: "5.00" },
              flatPrice: {
                dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
                displayAmount: "0.00",
              },
              firstUnit: 1,
              lastUnit: null,
            },
          ],
        },
      },
    ]

    const { val, err } = calculateTotalPricePlan({
      features: features as unknown as PlanVersionFeature[],
      quantities: { "f-tier": 2 },
      currency: "USD",
    })

    expect(err).toBeUndefined()
    // total: flat $10 + tier 2 * $5 = $20
    expect(toDecimal(val!.dinero)).toBe("20.00")
  })
})

describe("calculateFlatPricePlan", () => {
  it("should calculate flat price for a plan with flat features", () => {
    const billingConfig = {
      name: "test",
      billingInterval: "month",
      billingIntervalCount: 1,
      planType: "recurring",
      billingAnchor: 1,
    } as BillingConfig

    const planVersion: PlanVersionExtended = {
      id: "pv_4Hs8cAjTgxCWUpFSjta8bDFEkqpF",
      currency: "USD",
      projectId: "project_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
      version: 1,
      planId: "plan_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
      active: true,
      status: "published",
      paymentProvider: "stripe",
      collectionMethod: "charge_automatically",
      trialUnits: 0,
      autoRenew: true,
      paymentMethodRequired: false,
      billingConfig: billingConfig,
      planFeatures: [
        {
          id: "fv_4HsTVDfaaTtnAkq5sKB1Raj4tgaG",
          featureType: "flat",
          config: {
            price: {
              dinero: {
                amount: 3000,
                currency: {
                  code: "USD",
                  base: 10,
                  exponent: 2,
                },
                scale: 2,
              },
              displayAmount: "30.00",
            },
          },
          metadata: {
            realtime: false,
          },
          aggregationMethod: "sum",
          defaultQuantity: 1,
          limit: null,
          createdAtM: 0,
          updatedAtM: 0,
          projectId: "",
          planVersionId: "",
          featureId: "",
          order: 0,
          hidden: false,
          feature: {
            id: "feature_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
            slug: "feature-1",
          } as Feature,
          billingConfig: billingConfig,
        },
        {
          id: "fv_4HsTVDfaaTtnAkq5sKB1Raj4tg23G",
          featureType: "flat",
          config: {
            price: {
              dinero: {
                amount: 2000,
                currency: {
                  code: "USD",
                  base: 10,
                  exponent: 2,
                },
                scale: 2,
              },
              displayAmount: "20.00",
            },
          },
          metadata: {
            realtime: false,
          },
          aggregationMethod: "sum",
          defaultQuantity: 1,
          limit: null,
          createdAtM: 0,
          updatedAtM: 0,
          projectId: "",
          planVersionId: "",
          featureId: "",
          order: 0,
          hidden: false,
          feature: {
            id: "feature_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
            slug: "feature-2",
          } as Feature,
          billingConfig: billingConfig,
        },
      ],
      whenToBill: "pay_in_advance",
      gracePeriod: 0,
      metadata: null,
      createdAtM: 0,
      updatedAtM: 0,
      description: "",
      latest: true,
      title: "",
      tags: [],
      publishedAt: 0,
      publishedBy: "",
      archived: false,
      archivedAt: null,
      archivedBy: null,
      dueBehaviour: "cancel",
    }

    const result = calculateFlatPricePlan({ planVersion })
    expect(result.err).toBe(undefined)
    if (result.val) {
      expect(toDecimal(result.val.dinero)).toBe("50.00")
      expect(result.val.displayAmount).toBe("$50")
      expect(result.val.hasUsage).toBe(false)
    }
  })
})
