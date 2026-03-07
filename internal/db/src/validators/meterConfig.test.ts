import { describe, expect, it } from "vitest"

import { meterConfigSchema } from "./shared"

describe("meterConfigSchema", () => {
  it("accepts count without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "count",
    })

    expect(result.success).toBe(true)
  })

  it("rejects sum without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "sum",
    })

    expect(result.success).toBe(false)
  })

  it("rejects max without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "max",
    })

    expect(result.success).toBe(false)
  })

  it("rejects latest without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "latest",
    })

    expect(result.success).toBe(false)
  })

  it("rejects removed lifetime aggregations", () => {
    for (const aggregationMethod of ["sum", "count", "max"].map((method) => `${method}_all`)) {
      const result = meterConfigSchema.safeParse({
        eventId: "event_123",
        eventSlug: "llm_completion",
        aggregationMethod,
      })

      expect(result.success).toBe(false)
    }
  })
})
