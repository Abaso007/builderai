import { describe, expect, it } from "vitest"
import { calculateDateAt, calculateProration, getAnchor, getBillingCycleMessage } from "./utils"
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

describe("calculateProration (remaining fraction semantics)", () => {
  const ms = (s: number) => s * 1000

  it("returns 0 when start is greater than or equal to end", () => {
    expect(calculateProration(ms(10), ms(10), ms(10))).toEqual({
      prorationFactor: 0,
      billableSeconds: 0,
    })
    expect(calculateProration(ms(10), ms(9), ms(10))).toEqual({
      prorationFactor: 0,
      billableSeconds: 0,
    })
  })

  it("returns 1 when now is at or before start (bill full window)", () => {
    const start = ms(10)
    const end = ms(20)
    const atStart = calculateProration(start, end, start)
    const beforeStart = calculateProration(start, end, ms(5))
    expect(atStart.prorationFactor).toBe(1)
    expect(atStart.billableSeconds).toBe(Math.floor((end - start) / 1000))
    expect(beforeStart.prorationFactor).toBe(1)
    expect(beforeStart.billableSeconds).toBe(Math.floor((end - start) / 1000))
  })

  it("returns 0 when now is at or after end (nothing to bill)", () => {
    const start = ms(10)
    const end = ms(20)
    const result = calculateProration(start, end, ms(21))
    expect(result.prorationFactor).toBe(0)
    expect(result.billableSeconds).toBe(0)
  })

  it("returns ~0.5 when now is in the middle (bill remaining)", () => {
    const start = ms(10)
    const end = ms(20)
    const now = ms(15)
    const result = calculateProration(start, end, now)
    expect(result.prorationFactor).toBeCloseTo(0.5, 6)
    expect(result.billableSeconds).toBe(Math.floor((end - now) / 1000))
  })
})

describe("getAnchor", () => {
  const utc = (d: string, t = "00:00:00.000") => new Date(`${d}T${t}Z`).getTime()

  it("dayOfCreation for month/year returns day of month (UTC)", () => {
    const date = utc("2024-01-31")
    expect(getAnchor(date, "month", "dayOfCreation")).toBe(31)
    expect(getAnchor(date, "year", "dayOfCreation")).toBe(31)
  })

  it("validates minute/day/week numeric anchors and returns as-is", () => {
    const date = utc("2024-01-01")
    expect(getAnchor(date, "minute", 30)).toBe(30)
    expect(() => getAnchor(date, "minute", 60)).toThrow()
    expect(getAnchor(date, "day", 23)).toBe(23)
    expect(() => getAnchor(date, "day", 24)).toThrow()
    expect(getAnchor(date, "week", 6)).toBe(6)
    expect(() => getAnchor(date, "week", 7)).toThrow()
  })

  it("caps monthly anchor to the last day of the target month", () => {
    const jan31 = utc("2024-01-31")
    // February 2024 has 29 days
    expect(getAnchor(jan31, "month", 31)).toBe(31) // for ref month cap is done in window alignment
    // when aligning, the month end cap is applied (tested in billing tests)
    const apr30 = utc("2024-04-30")
    expect(getAnchor(apr30, "month", 31)).toBe(30)
  })
})
