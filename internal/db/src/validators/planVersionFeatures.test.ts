import { describe, expect, it } from "vitest"

import { planVersionFeatureInsertBaseSchema } from "./planVersionFeatures"

const billingConfig = {
  name: "monthly",
  billingInterval: "month" as const,
  billingIntervalCount: 1,
  billingAnchor: 1,
  planType: "recurring" as const,
}

describe("planVersionFeatureInsertBaseSchema", () => {
  it("accepts usage features with meterConfig and normalizes the legacy aggregation field", () => {
    const result = planVersionFeatureInsertBaseSchema.safeParse({
      featureId: "feature_123",
      planVersionId: "plan_version_123",
      featureType: "usage",
      billingConfig,
      order: 1024,
      defaultQuantity: 1,
      meterConfig: {
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod: "count",
      },
    })

    expect(result.success).toBe(true)

    if (!result.success) {
      return
    }

    expect(result.data.aggregationMethod).toBe("count")
  })

  it("rejects non-usage features carrying meterConfig", () => {
    const result = planVersionFeatureInsertBaseSchema.safeParse({
      featureId: "feature_123",
      planVersionId: "plan_version_123",
      featureType: "flat",
      billingConfig,
      order: 1024,
      defaultQuantity: 1,
      meterConfig: {
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod: "count",
      },
    })

    expect(result.success).toBe(false)
  })
})
