import type { BillingAnchor, BillingConfig, BillingInterval } from "../shared"
import { addUtc, setUtc, setUtcDay, startOfUtcDay, startOfUtcHour, startOfUtcSecond } from "./utils"

/**
 * Validates that the billing anchor is appropriate for the given interval.
 */
function validateAnchor(interval: BillingInterval, anchor: BillingAnchor): void {
  if (anchor === "dayOfCreation") return // Always valid for these

  // minute is anchored to the second
  if (interval === "minute" && (typeof anchor !== "number" || anchor < 0 || anchor > 59)) {
    throw new Error(
      `For minute intervals, anchor must be a second of the minute (0-59). Received: ${anchor}`
    )
  }

  // day is anchored to the hour
  if (interval === "day" && (typeof anchor !== "number" || anchor < 0 || anchor > 23)) {
    throw new Error(
      `For daily intervals, anchor must be a day of the hour (0-23). Received: ${anchor}`
    )
  }

  if (interval === "week" && (typeof anchor !== "number" || anchor < 0 || anchor > 6)) {
    throw new Error(
      `For weekly intervals, anchor must be a day of the week (0-6). Received: ${anchor}`
    )
  }
  if (
    (interval === "month" || interval === "year") &&
    (typeof anchor !== "number" || anchor < 1 || anchor > 31)
  ) {
    throw new Error(
      `For monthly/yearly intervals, anchor must be a day of the month (1-31). Received: ${anchor}`
    )
  }
}

function addByInterval(date: Date, interval: BillingInterval, count: number): Date {
  switch (interval) {
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
function calculateProration(
  start: number,
  end: number,
  now: number
): { prorationFactor: number; billableSeconds: number } {
  const totalDurationMs = end - start
  if (totalDurationMs <= 0) {
    return { prorationFactor: 1, billableSeconds: 0 }
  }

  // Elapsed time is capped by the cycle's own boundaries.
  const elapsedMs = Math.max(0, Math.min(now, end) - start)

  return {
    prorationFactor: elapsedMs / totalDurationMs,
    billableSeconds: Math.floor(elapsedMs / 1000),
  }
}

export interface CycleWindow {
  start: number
  end: number
  prorationFactor: number
  billableSeconds: number
}

export interface CalculateCycleWindowParams {
  effectiveStartDate: number
  effectiveEndDate: number | null
  trialEndsAt: number | null
  now: number
  billingConfig: BillingConfig
}

// =================================================================================
// CORE LOGIC: calculateCycleWindow
// This is the main function for determining a subscription's current time slice.
// =================================================================================
/**
 * Calculates the current cycle window for a subscription, including proration details.
 * All calculations are performed in UTC with exclusive end dates ([start, end)).
 *
 * @param params - The parameters for the calculation.
 * @returns The calculated CycleWindow with proration, or null if `now` is not in an active cycle.
 */
export function calculateCycleWindow(params: CalculateCycleWindowParams): CycleWindow | null {
  const { effectiveStartDate, effectiveEndDate, trialEndsAt, now, billingConfig } = params

  if (now < effectiveStartDate || (effectiveEndDate && now >= effectiveEndDate)) {
    return null
  }

  // --- 1. Handle Trial Cycle (No changes needed) ---
  if (trialEndsAt && now < trialEndsAt) {
    const start = effectiveStartDate
    const end = Math.min(trialEndsAt, effectiveEndDate ?? Number.POSITIVE_INFINITY)
    // trial is not billable
    return { start, end, prorationFactor: 0, billableSeconds: 0 }
  }

  // --- 2. Handle Onetime Plan Cycle (No changes needed) ---
  if (billingConfig.planType === "onetime") {
    const start = effectiveStartDate
    const end = effectiveEndDate ?? Number.POSITIVE_INFINITY
    const proration = calculateProration(start, end, now)
    return { start, end, ...proration }
  }

  // --- 3. Recurring Plan Validation and Setup (No changes needed) ---
  const { billingInterval, billingIntervalCount, billingAnchor } = billingConfig

  // allow numeric 0 anchors (e.g., daily at hour 0, minute at second 0)
  const isMissingAnchor =
    billingAnchor === undefined ||
    billingAnchor === null ||
    billingAnchor === ("" as unknown as BillingAnchor)

  if (!billingInterval || !billingIntervalCount || isMissingAnchor) {
    throw new Error("Recurring plans require full billing configuration.")
  }

  validateAnchor(billingInterval, billingAnchor)

  const paidPeriodStart = trialEndsAt
    ? Math.max(effectiveStartDate, trialEndsAt)
    : effectiveStartDate

  if (now < paidPeriodStart) {
    return null
  }

  const paidPeriodStartDateObj = new Date(paidPeriodStart)

  // --- 4. Find the First Paid Cycle Start Date (No changes needed) ---
  let firstPaidCycleStart: Date
  if (billingAnchor === "dayOfCreation") {
    firstPaidCycleStart = paidPeriodStartDateObj
  } else {
    // This logic correctly finds the first anchor date on or after the paid period starts.
    const tempDate = paidPeriodStartDateObj
    switch (billingInterval) {
      case "minute":
        firstPaidCycleStart = startOfUtcSecond(
          setUtc(tempDate, { seconds: billingAnchor as number })
        )
        break
      case "day":
        firstPaidCycleStart = startOfUtcHour(setUtc(tempDate, { hours: billingAnchor as number }))
        break
      case "week":
        firstPaidCycleStart = startOfUtcDay(setUtcDay(tempDate, billingAnchor as number, 0))
        break
      case "month":
      case "year":
        firstPaidCycleStart = startOfUtcDay(setUtc(tempDate, { date: billingAnchor as number }))
        break
      default:
        throw new Error(`Invalid billing interval: ${billingInterval}`)
    }
  }

  if (firstPaidCycleStart.getTime() < paidPeriodStartDateObj.getTime()) {
    firstPaidCycleStart = addByInterval(firstPaidCycleStart, billingInterval, billingIntervalCount)
  }

  // --- 5. Iterate to Find the Current Window (No changes needed) ---
  let currentCycleStart = firstPaidCycleStart

  // This check handles the case where `now` is in the initial "stub" period
  // before the first full anchor cycle begins.
  if (now < firstPaidCycleStart.getTime()) {
    // The current cycle runs from the paid period start to the first anchor.
    const start = paidPeriodStart
    const end = Math.min(
      firstPaidCycleStart.getTime(),
      effectiveEndDate ?? Number.POSITIVE_INFINITY
    )
    const proration = calculateProration(start, end, now)
    return { start, end, ...proration }
  }

  // If we are past the first anchor, find the correct cycle.
  let nextCycleStart = addByInterval(currentCycleStart, billingInterval, billingIntervalCount)
  while (now >= nextCycleStart.getTime()) {
    currentCycleStart = nextCycleStart
    nextCycleStart = addByInterval(currentCycleStart, billingInterval, billingIntervalCount)
  }

  // --- 6. Construct, Cap, and Return the Final Window ---
  const start = currentCycleStart.getTime()
  const end = Math.min(nextCycleStart.getTime(), effectiveEndDate ?? Number.POSITIVE_INFINITY)
  const proration = calculateProration(start, end, now)

  return { start, end, ...proration }
}

// =================================================================================
// 3. NEW PUBLIC FUNCTION: calculateNextNCycles
// This function now correctly reuses the logic from `calculateCurrentCycleWindow`.
// =================================================================================

export interface CalculateNextCyclesParams {
  /** The date to use as the starting point. The first cycle returned will contain this date. */
  referenceDate: number
  /** The effective start date of the entire subscription. */
  effectiveStartDate: number
  /** The effective end date of the subscription, or null if it never ends. */
  effectiveEndDate: number | null
  /** The date the trial ends, or null if there is no trial. */
  trialEndsAt: number | null
  /** The recurring billing configuration with a required numeric anchor. */
  billingConfig: Omit<BillingConfig, "billingAnchor"> & { billingAnchor: number }
  /** The total number of cycles to generate. */
  count: number
}

/**
 * Calculates the next N billing cycles for a subscription, starting from a given date.
 * This function intelligently handles trial periods and reuses the core cycle logic
 * to ensure consistency and robustness.
 *
 * @param params - The parameters for the calculation.
 * @returns An array of calculated cycles.
 */
export function calculateNextNCycles(params: CalculateNextCyclesParams): CycleWindow[] {
  const { referenceDate, effectiveStartDate, effectiveEndDate, trialEndsAt, billingConfig, count } =
    params

  // Onetime plans have a single window; return it if applicable
  if (billingConfig.planType === "onetime") {
    const single = calculateCycleWindow({
      now: referenceDate,
      effectiveStartDate,
      effectiveEndDate,
      trialEndsAt,
      billingConfig: billingConfig,
    })
    return single ? [single] : []
  }

  // If reference is before the subscription starts, nothing to return
  if (referenceDate < effectiveStartDate) return []

  const core = { effectiveStartDate, effectiveEndDate, trialEndsAt, billingConfig }

  const results: CycleWindow[] = []

  // Start from the very first window at the effective start
  let current = calculateCycleWindow({ now: effectiveStartDate, ...core })
  if (!current) return []
  results.push(current)

  // Accumulate all cycles up to and including the one that contains the reference date
  while (current.end <= referenceDate) {
    if (effectiveEndDate && current.end >= effectiveEndDate) break
    const next = calculateCycleWindow({ now: current.end, ...core })
    if (!next) break
    results.push(next)
    current = next
  }

  // Append `count` additional future cycles beyond the reference-containing window
  for (let i = 0; i < count; i++) {
    if (effectiveEndDate && current.end >= effectiveEndDate) break
    const next = calculateCycleWindow({ now: current.end, ...core })
    if (!next) break
    results.push(next)
    current = next
  }

  return results
}
