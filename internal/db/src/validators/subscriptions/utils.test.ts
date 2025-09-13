import { describe, expect, it } from "vitest"
import { calculateDateAt, getBillingCycleMessage } from "./utils"
import type { Config } from "./utils"

const utcDate = (date: string, time = "00:00:00.000") => new Date(`${date}T${time}Z`).getTime()

describe("calculateDateAt", () => {
  it("returns start date when no date is configured", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({ startDate: start, config: null })
    expect(end).toBe(start)
  })

  it("adds duration in days", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "day", units: 7 } as unknown as Config,
    })
    expect(end).toBe(utcDate("2024-01-08", "12:00:00.000"))
  })

  it("adds duration in minutes", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "minute", units: 5 } as unknown as Config,
    })
    expect(end).toBe(utcDate("2024-01-01", "12:05:00.000"))
  })

  it("adds duration in weeks", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "week", units: 2 } as unknown as Config,
    })

    expect(end).toBe(utcDate("2024-01-15", "12:00:00.000"))
  })

  it("adds duration in months", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "month", units: 2 } as unknown as Config,
    })

    expect(end).toBe(utcDate("2024-03-01", "12:00:00.000"))
  })

  it("adds duration in years", () => {
    const start = utcDate("2024-01-01", "12:00:00.000")
    const end = calculateDateAt({
      startDate: start,
      config: { interval: "year", units: 2 } as unknown as Config,
    })

    expect(end).toBe(utcDate("2026-01-01", "12:00:00.000"))
  })
})

describe("getBillingCycleMessage", () => {
  it("returns onetime message", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "onetime",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "onetime",
    })
    expect(msg.message).toBe("billed once")
  })

  it("returns monthly generic message when no anchor", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "recurring",
    })
    expect(msg.message).toBe("billed once every month")
  })

  it("returns anchored monthly message", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: 15,
      planType: "recurring",
    })
    expect(msg.message).toBe("billed monthly on the 15th of the month")
  })

  it("returns anchored yearly message", () => {
    const msg = getBillingCycleMessage({
      name: "test",
      billingInterval: "year",
      billingIntervalCount: 1,
      billingAnchor: 3,
      planType: "recurring",
    })
    expect(msg.message).toBe("billed yearly on the 1st of March")
  })
})
