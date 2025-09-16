import { endOfMonth } from "date-fns"
import { z } from "zod"
import {
  type BillingAnchor,
  type BillingConfig,
  type BillingInterval,
  billingIntervalSchema,
} from "../shared"

// Configuration for calculating a trial period.
export const configSchema = z.object({
  interval: billingIntervalSchema,
  units: z.number().min(1),
})
export type Config = z.infer<typeof configSchema>

// =================================================================================
// 2. STANDALONE UTILITY FUNCTION: calculateTrialEndsAt
// This function can be exported and used anywhere in the system to determine
// a trial's exact end timestamp.
// =================================================================================

/**
 * Calculates the exact UTC timestamp when a trial period ends.
 *
 * This function takes a start date and a trial configuration and returns
 * the future UTC timestamp marking the exclusive end of the trial ([start, end)).
 *
 * @param params - The parameters for the calculation.
 * @param params.startDate - The Unix timestamp (ms) when the subscription starts.
 * @param params.trialConfig - The trial configuration, or null/undefined if there's no trial.
 * @returns The Unix timestamp (ms) for the trial's end, or null if no trial is configured.
 */
export function calculateDateAt(params: {
  startDate: number
  config: Config | null | undefined
}): number {
  const { startDate, config } = params

  if (!config || config.units <= 0) {
    return startDate
  }

  // Establish the start date in UTC to ensure calculations are timezone-agnostic.
  const utcStartDate = new Date(startDate)

  // Add the trial period duration using the specified interval in UTC.
  const utcEndDate =
    config.interval === "minute"
      ? addUtc(utcStartDate, { minutes: config.units })
      : config.interval === "day"
        ? addUtc(utcStartDate, { days: config.units })
        : config.interval === "week"
          ? addUtc(utcStartDate, { weeks: config.units })
          : config.interval === "month"
            ? addUtc(utcStartDate, { months: config.units })
            : addUtc(utcStartDate, { years: config.units })

  return utcEndDate.getTime()
}

// given a billing interval, give a message to the user to explain the billing cycle
// like billed once every 30 days, billed once every month, billed once every year, billed once every 3 months, bill every 5 minutes
// bill yearly on the 1st of the month, bill monthly on the 1st of the month, bill weekly on monday, bill daily at 12:00
export function getBillingCycleMessage(billingConfig: BillingConfig): {
  message: string
} {
  const { billingInterval, billingIntervalCount, billingAnchor } = billingConfig

  const intervalCount = billingIntervalCount || 1

  // Handle one-time billing
  if (billingInterval === "onetime") {
    return { message: "billed once" }
  }

  // For regular intervals without a specific anchor
  if (!billingAnchor || billingAnchor === "dayOfCreation") {
    if (intervalCount === 1) {
      return {
        message: `billed ${billingInterval === "minute" ? "every" : "once every"} ${billingInterval}`,
      }
    }

    // Handle plural forms
    const intervalPlural =
      billingInterval === "day"
        ? "days"
        : billingInterval === "month"
          ? "months"
          : billingInterval === "year"
            ? "years"
            : billingInterval === "minute"
              ? "minutes"
              : billingInterval === "week"
                ? "weeks"
                : `${billingInterval}`

    return { message: `billed once every ${intervalCount} ${intervalPlural}` }
  }

  // For intervals with specific anchors
  if (billingInterval === "month") {
    const dayOfMonth = typeof billingAnchor === "number" ? billingAnchor : 1
    const day =
      dayOfMonth === 1
        ? "1st"
        : dayOfMonth === 2
          ? "2nd"
          : dayOfMonth === 3
            ? "3rd"
            : `${dayOfMonth}th`

    if (intervalCount === 1) {
      return { message: `billed monthly on the ${day} of the month` }
    }
    return { message: `billed every ${intervalCount} months on the ${day} of the month` }
  }

  if (billingInterval === "year") {
    const monthAnchor = typeof billingAnchor === "number" ? billingAnchor : 1
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]
    const month = monthNames[Math.min(Math.max(1, monthAnchor), 12) - 1]

    if (intervalCount === 1) {
      return { message: `billed yearly on the 1st of ${month}` }
    }
    return { message: `billed every ${intervalCount} years on the 1st of ${month}` }
  }

  // Default fallback for any other cases
  if (intervalCount === 1) {
    return { message: `billed every ${billingInterval}` }
  }
  return { message: `billed every ${intervalCount} ${billingInterval}s` }
}

export function addByInterval(date: Date, interval: BillingInterval, count: number): Date {
  switch (interval) {
    case "onetime":
      return date
    case "minute":
      return addUtc(date, { minutes: count })
    case "day":
      return addUtc(date, { days: count })
    case "week":
      return addUtc(date, { weeks: count })
    case "month":
      return addUtc(date, { months: count })
    case "year":
      return addUtc(date, { years: count })
    default:
      throw new Error(`Invalid billing interval: ${interval}`)
  }
}
/**
 * A helper to calculate proration metrics based on a cycle's start, end, and a 'now' timestamp.
 */
export function calculateProration(
  start: number,
  end: number,
  now: number
): { prorationFactor: number; billableSeconds: number } {
  const totalDurationMs = end - start

  if (totalDurationMs <= 0) {
    return { prorationFactor: 0, billableSeconds: 0 }
  }

  // Remaining-fraction semantics used by utils tests
  if (now >= end) {
    return { prorationFactor: 0, billableSeconds: 0 }
  }

  if (now <= start) {
    return {
      prorationFactor: 1,
      billableSeconds: Math.floor(totalDurationMs / 1000),
    }
  }

  const remainingMs = end - now
  return {
    prorationFactor: Math.min(1, Math.max(0, remainingMs / totalDurationMs)),
    billableSeconds: Math.floor(remainingMs / 1000),
  }
}

/**
 * Elapsed-fraction semantics used by billing window tests.
 * billableSeconds count from billableStart to now (clamped to [start, end]).
 */
export function calculateElapsedProration(
  start: number,
  end: number,
  now: number,
  billableStart?: number
): { prorationFactor: number; billableSeconds: number } {
  const totalDurationMs = end - start
  if (totalDurationMs <= 0) return { prorationFactor: 0, billableSeconds: 0 }

  const effectiveBillableStart = billableStart ?? start
  const clampedNow = Math.min(now, end)
  if (clampedNow <= effectiveBillableStart) return { prorationFactor: 0, billableSeconds: 0 }

  const elapsedMs = clampedNow - effectiveBillableStart
  return {
    prorationFactor: Math.min(1, Math.max(0, elapsedMs / totalDurationMs)),
    billableSeconds: Math.floor(elapsedMs / 1000),
  }
}

export function getAnchor(date: number, interval: BillingInterval, anchor: BillingAnchor): number {
  const ref = new Date(date)

  // Derive from creation date in UTC when requested
  if (anchor === "dayOfCreation") {
    switch (interval) {
      case "minute":
        return ref.getUTCSeconds() // 0-59
      case "day":
        return ref.getUTCHours() // 0-23
      case "week":
        return ref.getUTCDay() // 0-6 (Sun-Sat)
      case "month":
      case "year":
      case "onetime":
        return ref.getUTCDate() // 1-31
      default:
        return ref.getUTCDate()
    }
  }

  // Numeric anchor provided: validate per interval and normalize using UTC context
  const numeric = Number(anchor)
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid billing anchor: ${String(anchor)}`)
  }

  switch (interval) {
    case "minute": {
      if (numeric < 0 || numeric > 59) {
        throw new Error("For minute intervals, anchor must be 0-59 (second of minute).")
      }
      return numeric
    }
    case "day": {
      if (numeric < 0 || numeric > 23) {
        throw new Error("For daily intervals, anchor must be 0-23 (hour of day UTC).")
      }
      return numeric
    }
    case "week": {
      if (numeric < 0 || numeric > 6) {
        throw new Error("For weekly intervals, anchor must be 0-6 (0=Sun ... 6=Sat).")
      }
      return numeric
    }
    case "month": {
      if (numeric < 1) {
        throw new Error("For monthly intervals, anchor must be 1-31 (day of month).")
      }
      const last = endOfMonth(ref).getUTCDate()
      return Math.min(numeric, last)
    }
    case "year": {
      if (numeric < 1) {
        throw new Error("For yearly intervals, anchor must be 1-31 (day of month).")
      }
      // Yearly plans use day-of-month anchoring; cap to last day for the reference month
      const last = endOfMonth(ref).getUTCDate()
      return Math.min(numeric, last)
    }
    case "onetime": {
      // One-time plans don't recur; return 0 as anchor
      return 0
    }
    default:
      return ref.getUTCDate()
  }
}

export function startOfUtcDay(date: Date): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0))
}

export function startOfUtcHour(date: Date): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  const h = date.getUTCHours()
  return new Date(Date.UTC(y, m, d, h, 0, 0, 0))
}

export function startOfUtcMinute(date: Date): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  const h = date.getUTCHours()
  const min = date.getUTCMinutes()
  return new Date(Date.UTC(y, m, d, h, min, 0, 0))
}

export function startOfUtcSecond(date: Date): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = date.getUTCDate()
  const h = date.getUTCHours()
  const min = date.getUTCMinutes()
  const s = date.getUTCSeconds()
  return new Date(Date.UTC(y, m, d, h, min, s, 0))
}

export function setUtc(
  date: Date,
  parts: { seconds?: number; hours?: number; date?: number }
): Date {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const d = parts.date ?? date.getUTCDate()
  const h = parts.hours ?? date.getUTCHours()
  const min = date.getUTCMinutes()
  const s = parts.seconds ?? date.getUTCSeconds()
  const ms = date.getUTCMilliseconds()
  return new Date(Date.UTC(y, m, d, h, min, s, ms))
}

function startOfUtcWeek(date: Date, weekStartsOn = 0): Date {
  const sod = startOfUtcDay(date)
  const dow = sod.getUTCDay()
  const diff = (dow - weekStartsOn + 7) % 7
  return new Date(sod.getTime() - diff * 86400000)
}

export function setUtcDay(date: Date, day: number, weekStartsOn = 0): Date {
  const sow = startOfUtcWeek(date, weekStartsOn)
  return new Date(sow.getTime() + day * 86400000)
}

export function addUtc(
  date: Date,
  amount: {
    minutes?: number
    hours?: number
    days?: number
    weeks?: number
    months?: number
    years?: number
  }
): Date {
  const d = new Date(date.getTime())
  if (amount.minutes) d.setUTCMinutes(d.getUTCMinutes() + amount.minutes)
  if (amount.hours) d.setUTCHours(d.getUTCHours() + amount.hours)
  if (amount.days) d.setUTCDate(d.getUTCDate() + amount.days)
  if (amount.weeks) d.setUTCDate(d.getUTCDate() + 7 * amount.weeks)
  if (amount.months) d.setUTCMonth(d.getUTCMonth() + amount.months)
  if (amount.years) d.setUTCFullYear(d.getUTCFullYear() + amount.years)
  return d
}
