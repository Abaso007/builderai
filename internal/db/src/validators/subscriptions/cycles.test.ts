import { describe, expect, it } from "vitest"
import { enumerateBillingWindows } from "./billing"

const utcDate = (date: string, time = "00:00:00.000") => new Date(`${date}T${time}Z`).getTime()

describe("enumerateBillingWindows", () => {
  it("enumerates monthly cycles from startAt until now", () => {
    const startAt = utcDate("2024-01-10", "00:00:00.000")
    const now = utcDate("2024-04-05", "00:00:00.000")
    const anchor = 15

    const windows = enumerateBillingWindows({
      startAt,
      now,
      anchor,
      interval: "month",
      intervalCount: 1,
    })

    expect(windows).toEqual([
      // first partial: Jan 10 -> Jan 15
      {
        start: utcDate("2024-01-10", "00:00:00.000"),
        end: utcDate("2024-01-15", "00:00:00.000") - 1,
      },
      // full: Jan 15 -> Feb 15
      {
        start: utcDate("2024-01-15", "00:00:00.000"),
        end: utcDate("2024-02-15", "00:00:00.000") - 1,
      },
      // full: Feb 15 -> Mar 15
      {
        start: utcDate("2024-02-15", "00:00:00.000"),
        end: utcDate("2024-03-15", "00:00:00.000") - 1,
      },
      // last window should end at cycle end (Apr 15) since no endAt
      {
        start: utcDate("2024-03-15", "00:00:00.000"),
        end: utcDate("2024-04-15", "00:00:00.000") - 1,
      },
    ])
  })

  it("caps at endAt if provided", () => {
    const startAt = utcDate("2024-01-10", "00:00:00.000")
    const now = utcDate("2024-04-20", "00:00:00.000")
    const endAt = utcDate("2024-03-10", "00:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      endAt,
      anchor: 15,
      interval: "month",
      intervalCount: 1,
    })

    const last = windows.at(-1)
    expect(last?.end).toBe(endAt)
  })

  it("includes trial window before recurring cycles", () => {
    const startAt = utcDate("2024-01-01", "00:00:00.000")
    const trialEndsAt = utcDate("2024-01-07", "00:00:00.000")
    const now = utcDate("2024-01-20", "00:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      trialEndsAt,
      anchor: 15,
      interval: "month",
      intervalCount: 1,
    })

    expect(windows[0]).toEqual({ start: startAt, end: trialEndsAt - 1, isTrial: true })
    expect(windows[1]?.start).toBeGreaterThanOrEqual(trialEndsAt)
  })

  it("onetime: single window from startAt to max date", () => {
    const startAt = utcDate("2024-01-01", "00:00:00.000")
    const now = utcDate("2024-02-01", "00:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      anchor: 0,
      interval: "onetime",
      intervalCount: 1,
    })

    expect(windows).toEqual([
      { start: startAt, end: new Date("9999-12-31T23:59:59.999Z").getTime(), isTrial: false },
    ])
  })

  it("daily cycles without endAt end at current cycle end", () => {
    const startAt = utcDate("2024-01-10", "06:30:00.000")
    const now = utcDate("2024-01-12", "03:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      anchor: 0,
      interval: "day",
      intervalCount: 1,
    })

    // Expect: [Jan10 06:30 -> Jan11 00:00], [Jan11 00:00 -> Jan12 00:00], [Jan12 00:00 -> Jan13 00:00]
    expect(windows.at(-1)?.end).toBe(utcDate("2024-01-13", "00:00:00.000") - 1)
  })

  it("minute cycles without endAt end at current cycle end", () => {
    const startAt = utcDate("2024-01-01", "12:34:20.000")
    const now = utcDate("2024-01-01", "12:36:10.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      anchor: 0,
      interval: "minute",
      intervalCount: 5, // 5-minute cycles
    })

    // With 5-minute cycles aligned by minute floor, the current cycle containing now (12:36:10)
    // ends at 12:41
    expect(windows.at(-1)?.end).toBe(utcDate("2024-01-01", "12:41:00.000") - 1)
  })

  it("trial window capped by endAt before recurring cycles", () => {
    const startAt = utcDate("2024-01-01", "00:00:00.000")
    const trialEndsAt = utcDate("2024-01-10", "00:00:00.000")
    const endAt = utcDate("2024-01-07", "00:00:00.000")
    const now = utcDate("2024-01-20", "00:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      trialEndsAt,
      endAt,
      anchor: 15,
      interval: "month",
      intervalCount: 1,
    })

    // Only the trial window should appear and be capped at endAt (inclusive end)
    expect(windows).toEqual([{ start: startAt, end: endAt - 1, isTrial: true }])
  })

  it("yearly cycles without endAt end at current cycle end (anchor month)", () => {
    const startAt = utcDate("2023-04-10", "00:00:00.000")
    const now = utcDate("2024-02-01", "00:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      anchor: 3, // March
      interval: "year",
      intervalCount: 1,
    })

    // The current yearly window should end Mar 1, 2024
    expect(windows.at(-1)?.end).toBe(utcDate("2024-03-01", "00:00:00.000") - 1)
  })

  it("windows are contiguous for monthly with trial", () => {
    const startAt = utcDate("2024-01-01", "00:00:00.000")
    const trialEndsAt = utcDate("2024-01-07", "00:00:00.000")
    const now = utcDate("2024-03-20", "00:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      trialEndsAt,
      anchor: 15,
      interval: "month",
      intervalCount: 1,
    })

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.start).toBe((windows[i - 1]?.end ?? 0) + 1)
    }
  })

  it("windows are contiguous for daily cycles", () => {
    const startAt = utcDate("2024-01-10", "06:30:00.000")
    const now = utcDate("2024-01-12", "03:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      anchor: 0,
      interval: "day",
      intervalCount: 1,
    })

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.start).toBe((windows[i - 1]?.end ?? 0) + 1)
    }
  })

  it("windows are contiguous for minute cycles", () => {
    const startAt = utcDate("2024-01-01", "12:34:20.000")
    const now = utcDate("2024-01-01", "12:36:10.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      anchor: 0,
      interval: "minute",
      intervalCount: 5,
    })

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.start).toBe((windows[i - 1]?.end ?? 0) + 1)
    }
  })

  it("windows are contiguous when endAt caps monthly cycles", () => {
    const startAt = utcDate("2024-01-10", "00:00:00.000")
    const now = utcDate("2024-04-20", "00:00:00.000")
    const endAt = utcDate("2024-03-10", "00:00:00.000")

    const windows = enumerateBillingWindows({
      startAt,
      now,
      endAt,
      anchor: 15,
      interval: "month",
      intervalCount: 1,
    })

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.start).toBe((windows[i - 1]?.end ?? 0) + 1)
    }
    expect(windows.at(-1)?.end).toBe(endAt)
  })
})
