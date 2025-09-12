import { describe, expect, it } from "vitest"
import { getCurrentBillingWindow } from "./billing"

const utcDate = (date: string, time = "00:00:00.000") => new Date(`${date}T${time}Z`).getTime()

describe("getCurrentBillingWindow", () => {
  describe("trial handling", () => {
    it("returns now->trialEndsAt when in trial and no endAt", () => {
      const now = utcDate("2024-01-01", "12:00:00.000")
      const trialEndsAt = utcDate("2024-01-10", "00:00:00.000")

      const result = getCurrentBillingWindow({
        now,
        trialEndsAt,
        endAt: null,
        // interval-related options are ignored during trial
        anchor: 15,
        interval: "month",
        intervalCount: 1,
      })

      expect(result.start).toBe(now)
      expect(result.end).toBe(trialEndsAt - 1)
    })

    it("uses the earlier of trialEndsAt and endAt as effective end", () => {
      const now = utcDate("2024-01-01", "12:00:00.000")
      const trialEndsAt = utcDate("2024-01-10", "00:00:00.000")
      const endAt = utcDate("2024-01-05", "00:00:00.000")

      const result = getCurrentBillingWindow({
        now,
        trialEndsAt,
        endAt,
        anchor: 15,
        interval: "month",
        intervalCount: 1,
      })

      expect(result.start).toBe(now)
      expect(result.end).toBe(endAt - 1) // inclusive end, last ms before endAt
    })
  })

  describe("recurring windows", () => {
    it("monthly: anchors to the previous anchor day when now is after anchor", () => {
      const now = utcDate("2024-01-20", "08:30:00.000")
      // anchor on the 15th of the month
      const expectedStart = utcDate("2024-01-15", "00:00:00.000")
      const expectedEnd = utcDate("2024-02-15", "00:00:00.000") - 1

      const result = getCurrentBillingWindow({
        now,
        trialEndsAt: null,
        endAt: null,
        anchor: 15,
        interval: "month",
        intervalCount: 1,
      })

      expect(result.start).toBe(expectedStart)
      expect(result.end).toBe(expectedEnd)
    })

    it("caps window end at endAt when endAt is before computed end", () => {
      const now = utcDate("2024-01-20", "08:30:00.000")
      const endAt = utcDate("2024-01-25", "00:00:00.000")
      const expectedStart = utcDate("2024-01-15", "00:00:00.000")

      const result = getCurrentBillingWindow({
        now,
        trialEndsAt: null,
        endAt,
        anchor: 15,
        interval: "month",
        intervalCount: 1,
      })

      expect(result.start).toBe(expectedStart)
      expect(result.end).toBe(endAt)
    })

    it("minute: floors start to beginning of minute and ends at +intervalCount minutes", () => {
      const now = utcDate("2024-01-01", "12:34:56.789")
      const expectedStart = utcDate("2024-01-01", "12:34:00.000")
      const expectedEnd = utcDate("2024-01-01", "12:39:00.000") - 1 // inclusive end of 5-min window

      const result = getCurrentBillingWindow({
        now,
        trialEndsAt: null,
        endAt: null,
        anchor: 0,
        interval: "minute",
        intervalCount: 5,
      })

      expect(result.start).toBe(expectedStart)
      expect(result.end).toBe(expectedEnd)
    })

    it("onetime: returns startAt->max date when not in trial", () => {
      const now = utcDate("2024-01-01", "09:15:45.123")

      const result = getCurrentBillingWindow({
        now,
        trialEndsAt: null,
        endAt: null,
        anchor: 0,
        interval: "onetime",
        intervalCount: 1,
      })

      expect(result.start).toBe(now)
      expect(result.end).toBe(new Date("9999-12-31T23:59:59.999Z").getTime())
    })

    it("yearly: computes a yearly window based on month anchor", () => {
      const now = utcDate("2024-02-01", "00:00:00.000")
      // anchor=3 -> March as anchor month; window should start at Mar 1, 2023 and end Mar 1, 2024 when now is Feb 1, 2024
      const expectedStart = utcDate("2023-03-01", "00:00:00.000")
      const expectedEnd = utcDate("2024-03-01", "00:00:00.000") - 1

      const result = getCurrentBillingWindow({
        now,
        trialEndsAt: null,
        endAt: null,
        anchor: 3,
        interval: "year",
        intervalCount: 1,
      })

      expect(result.start).toBe(expectedStart)
      expect(result.end).toBe(expectedEnd)
    })
  })
})
