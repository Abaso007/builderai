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

  it("accepts count_all without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "count_all",
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

  it("rejects last_during_period without aggregationField", () => {
    const result = meterConfigSchema.safeParse({
      eventId: "event_123",
      eventSlug: "llm_completion",
      aggregationMethod: "last_during_period",
    })

    expect(result.success).toBe(false)
  })
})
