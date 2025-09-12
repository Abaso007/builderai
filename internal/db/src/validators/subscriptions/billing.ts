import { addDays, addMinutes, addMonths, addYears, differenceInSeconds, endOfMonth } from "date-fns"
import type { BillingConfig, BillingInterval } from "../shared"

// map of the interval to the add function
export const intervalMapFunction = {
  minute: addMinutes,
  day: addDays,
  month: addMonths,
  year: addYears,
  onetime: (d: Date, _: number) => d,
}

interface BillingCycleResult {
  cycleStartMs: number // UTC timestamp in milliseconds
  cycleEndMs: number // UTC timestamp in milliseconds
  secondsInCycle: number
  prorationFactor: number
  billableSeconds: number
  trialEndsAtMs?: number // UTC timestamp in milliseconds
}

/**
 * Calculates the start and end timestamps of the current billing window, handling trials, anchors, and intervals.
 * All calculations are done in UTC to avoid timezone issues.
 *
 * @param opts Parameters for the calculation.
 * @param opts.now The current timestamp.
 * @param opts.trialEndsAt The timestamp when the trial ends (or null if no trial).
 * @param opts.endAt The timestamp when the subscription ends (or null if no end date).
 * @param opts.anchor The timestamp or ordinal value of the billing cycle anchor.
 *               For daily/weekly intervals, it's a timestamp.
 *               For monthly intervals, it's the day of the month (1-31).
 *               For yearly intervals, it's the day of the year (1-366).
 * @param opts.interval The billing interval unit ('onetime', 'minute', 'day', 'month', 'year').
 * @param opts.intervalCount The number of intervals per cycle.
 * @returns An object containing the start and end timestamps of the current billing window.
 */
export function getCurrentBillingWindow(opts: {
  now: number
  trialEndsAt: number | null
  endAt: number | null
  anchor: number
  interval: BillingInterval
  intervalCount: number
  startAt?: number // optional subscription start (UTC ms)
}): {
  start: number
  end: number
} {
  const { now, trialEndsAt, endAt, anchor, interval, intervalCount, startAt } = opts

  const effectiveEndAt = endAt ?? null

  // 1. Handle Trial Period (only when trial is active)
  if (trialEndsAt != null && now < trialEndsAt) {
    const trialWindowEnd = endAt != null ? Math.min(trialEndsAt, endAt) : trialEndsAt
    return {
      start: startAt ?? now,
      // inclusive end — last ms before the paid window starts at trialEndsAt
      end: Math.max((trialWindowEnd ?? now) - 1, now),
    }
  }

  // Handle one-time interval explicitly: if startAt provided, window is [startAt, effectiveEndAt ?? now]
  if (interval === "onetime") {
    const windowStart = startAt ?? now
    // one-time subscriptions never end; represent as a far-future max date
    const windowEnd = new Date("9999-12-31T23:59:59.999Z").getTime()
    return { start: windowStart, end: windowEnd }
  }

  // 2. Handle Recurring Billing Cycles
  const nowUTCDate = new Date(now)
  let windowStartDate: Date

  switch (interval) {
    case "minute": {
      // floor to minute
      windowStartDate = new Date(nowUTCDate)
      windowStartDate.setUTCSeconds(0, 0)
      break
    }
    case "day": {
      // If startAt provided, align cycles from startAt every intervalCount days
      if (startAt) {
        const startDay = new Date(startAt)
        startDay.setUTCHours(0, 0, 0, 0)
        // compute how many full intervals have elapsed
        const diffDays = Math.floor(
          (nowUTCDate.getTime() - startDay.getTime()) / (24 * 60 * 60 * 1000)
        )
        const intervalsElapsed = Math.floor(diffDays / intervalCount)
        windowStartDate = new Date(startDay)
        windowStartDate.setUTCDate(startDay.getUTCDate() + intervalsElapsed * intervalCount)
      } else {
        // fallback: start of current UTC day
        windowStartDate = new Date(nowUTCDate)
        windowStartDate.setUTCHours(0, 0, 0, 0)
      }
      break
    }
    case "month": {
      const nowYear = nowUTCDate.getUTCFullYear()
      const nowMonth = nowUTCDate.getUTCMonth()
      const anchorDay =
        typeof anchor === "number"
          ? Math.min(Math.max(1, anchor), 31)
          : startAt
            ? new Date(startAt).getUTCDate()
            : 1

      // seed at this month anchor
      windowStartDate = new Date(Date.UTC(nowYear, nowMonth, anchorDay))
      while (windowStartDate.getTime() > now) {
        windowStartDate.setUTCMonth(windowStartDate.getUTCMonth() - intervalCount)
      }
      while (addMonths(windowStartDate, intervalCount).getTime() <= now) {
        windowStartDate = addMonths(windowStartDate, intervalCount)
      }
      break
    }
    case "year": {
      const nowYear = nowUTCDate.getUTCFullYear()
      const anchorMonth =
        typeof anchor === "number"
          ? Math.min(Math.max(1, anchor), 12)
          : startAt
            ? new Date(startAt).getUTCMonth() + 1
            : 1
      windowStartDate = new Date(Date.UTC(nowYear, anchorMonth - 1, 1))
      while (windowStartDate.getTime() > now) {
        windowStartDate.setUTCFullYear(windowStartDate.getUTCFullYear() - intervalCount)
      }
      while (addYears(windowStartDate, intervalCount).getTime() <= now) {
        windowStartDate = addYears(windowStartDate, intervalCount)
      }
      break
    }
    default:
      throw new Error(`Unsupported interval type: ${interval}`)
  }

  // Make a copy of windowStartDate before calculating end
  const currentWindowStart = new Date(windowStartDate.getTime())

  // Now that we have windowStartDate, let's find the end of the billing window
  let windowEndDate: Date
  const nextWindowStartDate = new Date(currentWindowStart)
  switch (interval) {
    case "year":
      nextWindowStartDate.setUTCFullYear(nextWindowStartDate.getUTCFullYear() + intervalCount)
      windowEndDate = new Date(nextWindowStartDate.getTime() - 1)
      break
    case "month":
      nextWindowStartDate.setUTCMonth(nextWindowStartDate.getUTCMonth() + intervalCount)
      windowEndDate = new Date(nextWindowStartDate.getTime() - 1)
      break
    case "minute":
      nextWindowStartDate.setUTCMinutes(nextWindowStartDate.getUTCMinutes() + intervalCount)
      windowEndDate = new Date(nextWindowStartDate.getTime() - 1)
      break
    case "day":
      nextWindowStartDate.setUTCDate(nextWindowStartDate.getUTCDate() + intervalCount)
      windowEndDate = new Date(nextWindowStartDate.getTime() - 1)
      break
    default:
      throw new Error(`Unsupported interval type: ${interval}`)
  }

  // If the window end date is after the effective end date, set it to the effective end date
  if (effectiveEndAt && windowEndDate.getTime() > effectiveEndAt) {
    windowEndDate = new Date(effectiveEndAt)
  }

  return {
    start: windowStartDate.getTime(),
    end: windowEndDate.getTime(),
  }
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

export function enumerateBillingWindows(opts: {
  startAt: number
  now: number
  anchor: number
  interval: BillingInterval
  intervalCount: number
  trialEndsAt?: number | null
  endAt?: number | null
  maxCycles?: number
}): Array<{ start: number; end: number } | { start: number; end: number; isTrial: boolean }> {
  const {
    startAt,
    now,
    anchor,
    interval,
    intervalCount,
    trialEndsAt = null,
    endAt = null,
    maxCycles = 1000,
  } = opts

  const windows: Array<
    { start: number; end: number } | { start: number; end: number; isTrial: boolean }
  > = []
  // Determine hard stop: if endAt provided, cap there; otherwise, include the full
  // billing window that contains "now" (do not end partial at now)
  const hardStop = (() => {
    if (endAt != null) return endAt
    const currentWindow = getCurrentBillingWindow({
      now,
      trialEndsAt,
      endAt: null,
      anchor,
      interval,
      intervalCount,
      startAt,
    })
    return currentWindow.end
  })()

  // 1) Trial window first (if applicable and intersects timeline)
  let cursor = startAt
  if (trialEndsAt != null && cursor <= trialEndsAt && cursor <= hardStop) {
    const trialEndBoundary = Math.min(trialEndsAt, hardStop)
    const trialEndInclusive = trialEndBoundary - 1
    if (cursor <= trialEndInclusive) {
      windows.push({ start: cursor, end: trialEndInclusive, isTrial: true })
    }
    cursor = trialEndInclusive + 1
  }

  if (cursor > hardStop) return windows

  // 2) Onetime plan -> single window from start to far-future max date
  if (interval === "onetime") {
    windows.push({
      start: cursor,
      end: new Date("9999-12-31T23:59:59.999Z").getTime(),
      isTrial: false,
    })
    return windows
  }

  // 3) Recurring cycles up to now/hardStop
  let safety = 0
  while (cursor <= hardStop && safety < maxCycles) {
    safety += 1
    const current = getCurrentBillingWindow({
      now: cursor,
      trialEndsAt: null,
      endAt: endAt,
      anchor,
      interval,
      intervalCount,
      startAt,
    })

    const boundedStart = Math.max(current.start, cursor)
    const boundedEnd = Math.min(current.end, hardStop)
    if (boundedStart >= boundedEnd) break
    // For recurring cycles, do not include isTrial flag
    windows.push({ start: boundedStart, end: boundedEnd })

    if (boundedEnd >= hardStop) break
    cursor = boundedEnd + 1
  }

  return windows
}

export function configureBillingCycleSubscription({
  trialUnits = 0,
  currentCycleStartAt,
  billingConfig,
  endAt,
  alignStartToDay = false,
  alignEndToDay = true,
  alignToCalendar = true,
}: {
  trialUnits?: number
  currentCycleStartAt: number
  billingConfig: BillingConfig
  endAt?: number
  alignStartToDay?: boolean
  alignEndToDay?: boolean
  alignToCalendar?: boolean
}): BillingCycleResult {
  // Handle trial period
  if (trialUnits > 0) {
    // handle trial for minute based intervals
    const millisecondsInCycle =
      billingConfig.billingInterval === "minute" ? 60 * 1000 : 24 * 60 * 60 * 1000
    const millisecondsInTrial = trialUnits * millisecondsInCycle
    // add to the start date, the trial days milliseconds and subtract 1 millisecond to avoid overlapping
    const trialEndsAtMs = currentCycleStartAt + millisecondsInTrial - 1 // -1 comes from the millisecondsInCycle we are counting the whole day
    // end date happens when there is a specific end date for the subscription
    const effectiveEndMs = endAt ? Math.min(trialEndsAtMs, endAt) : trialEndsAtMs

    if (currentCycleStartAt > effectiveEndMs) {
      throw new Error("Start date is after the end date")
    }

    return {
      cycleStartMs: currentCycleStartAt,
      cycleEndMs: effectiveEndMs,
      secondsInCycle: differenceInSeconds(effectiveEndMs, currentCycleStartAt),
      prorationFactor: 0,
      billableSeconds: 0,
      trialEndsAtMs,
    }
  }

  // Calculate next interval
  const interval = calculateNextInterval(currentCycleStartAt, billingConfig, {
    alignToCalendar,
    alignStartToDay,
    alignEndToDay,
  })

  // Calculate effective dates and proration
  const effectiveStartMs = Math.max(currentCycleStartAt, interval.start)
  const effectiveEndMs = endAt ? Math.min(endAt, interval.end) : interval.end

  if (effectiveStartMs > effectiveEndMs) {
    throw new Error("Effective start date is after the effective end date")
  }

  // Handle onetime interval
  if (billingConfig.billingInterval === "onetime") {
    return {
      cycleStartMs: interval.start,
      // onetime is forever
      cycleEndMs: new Date("9999-12-31T23:59:59.999Z").getTime(), // max date in the future
      secondsInCycle: Number.POSITIVE_INFINITY,
      prorationFactor: 1, // proration factor is 1 because the subscription is onetime
      billableSeconds: Number.POSITIVE_INFINITY,
    }
  }

  return {
    cycleStartMs: interval.start,
    cycleEndMs: interval.end,
    secondsInCycle: interval.secondsInCycle,
    prorationFactor: interval.prorationFactor,
    billableSeconds: interval.billableSeconds,
  }
}

function validateAnchor(interval: BillingInterval, anchor: number | "dayOfCreation"): number {
  if (anchor === "dayOfCreation") {
    // INFO: this will return the date in the UTC timezone
    return new Date().getUTCDate() // get the date the subscription was created
  }

  if (interval === "month") {
    // For months, anchor should be 1-31, if greater use 31
    return Math.min(Math.max(1, anchor), 31)
  }
  if (interval === "year") {
    // For years, anchor should be 1-12, if greater use 12
    return Math.min(Math.max(1, anchor), 12)
  }

  return anchor
}

function getAnchorDate(
  date: Date,
  interval: BillingInterval,
  anchor: number,
  endOfPeriod = false
): Date {
  let result = new Date(date)

  if (interval === "month") {
    // For month, handle last day of month cases
    if (anchor >= 31) {
      return endOfMonth(result)
    }
    const lastDayOfMonth = endOfMonth(result).getUTCDate()
    result.setUTCDate(Math.min(anchor, lastDayOfMonth))
  } else if (interval === "year") {
    // For year, set to start/end of anchor month
    result.setUTCMonth(anchor - 1)
    if (endOfPeriod) {
      result.setUTCDate(1)
      result = endOfMonth(result)
      result.setUTCHours(23, 59, 59, 999)
    } else {
      result.setUTCDate(1)
      result.setUTCHours(0, 0, 0, 0)
    }
  }

  return result
}

function alignPeriodBoundary(date: Date, alignToDay: boolean, isEnd: boolean): Date {
  if (!alignToDay) return date

  const result = new Date(date)
  if (isEnd) {
    // Set to end of day in UTC
    result.setUTCHours(23, 59, 59, 999)
  } else {
    // Set to start of day in UTC
    result.setUTCHours(0, 0, 0, 0)
  }
  return result
}

// calculate the next interval for a subscription
// given its billing config and the current cycle start date
export function calculateNextInterval(
  startDate: number,
  billingConfig: BillingConfig,
  options: {
    alignToCalendar?: boolean
    alignStartToDay?: boolean
    alignEndToDay?: boolean
  } = {
    alignToCalendar: true,
    alignStartToDay: false,
    alignEndToDay: true,
  }
): {
  start: number
  end: number
  secondsInCycle: number
  billableSeconds: number
  prorationFactor: number
} {
  const date = new Date(startDate)
  let endDate: Date

  const { billingInterval, billingIntervalCount, billingAnchor } = billingConfig

  const addFunction = intervalMapFunction[billingInterval]

  if (!addFunction) {
    throw new Error(`Unsupported interval: ${billingInterval}`)
  }

  // Handle onetime interval
  if (billingInterval === "onetime") {
    return {
      start: startDate,
      end: new Date("9999-12-31T23:59:59.999Z").getTime(),
      secondsInCycle: Number.POSITIVE_INFINITY,
      billableSeconds: Number.POSITIVE_INFINITY,
      prorationFactor: 1,
    }
  }

  // Handle calendar-aligned intervals with anchor
  if (
    options?.alignToCalendar &&
    billingAnchor &&
    (billingInterval === "month" || billingInterval === "year")
  ) {
    const anchor = validateAnchor(billingInterval, billingAnchor)

    let startDateFull: Date
    let endDateFull: Date

    if (billingInterval === "month") {
      // First calculate the full cycle duration without anchor
      // start date is the first day of the cycle with the anchor
      // for instance if the current date is 3th of the month and the anchor is 15, the start date will be 15th of the previous month
      startDateFull = getAnchorDate(
        addFunction(date, billingIntervalCount - 1),
        billingInterval,
        anchor
      )
      endDateFull = getAnchorDate(
        addFunction(date, billingIntervalCount),
        billingInterval,
        anchor,
        true
      )

      const currentDay = date.getUTCDate()
      const lastDayOfMonth = endOfMonth(date).getUTCDate()

      // If we're on the last day of month and anchor is >= that day
      // OR if we're exactly on the anchor day
      // then take the full interval
      if ((currentDay === lastDayOfMonth && anchor >= lastDayOfMonth) || currentDay === anchor) {
        endDate = getAnchorDate(
          addFunction(date, billingIntervalCount),
          billingInterval,
          anchor,
          true
        )
      } else if (currentDay > anchor) {
        // If we're past the anchor, get next month's anchor plus remaining intervals
        endDate = getAnchorDate(
          addFunction(date, billingIntervalCount),
          billingInterval,
          anchor,
          true
        )
      } else {
        // If we're before the anchor, get this month's anchor plus remaining intervals
        endDate = getAnchorDate(
          addFunction(date, billingIntervalCount - 1),
          billingInterval,
          anchor,
          true
        )
      }
    } else {
      // year
      startDateFull = getAnchorDate(
        addFunction(date, billingIntervalCount - 1),
        billingInterval,
        anchor
      )
      endDateFull = getAnchorDate(
        addFunction(date, billingIntervalCount),
        billingInterval,
        anchor,
        true
      )
      const yearAnchor = anchor
      const currentMonth = date.getUTCMonth() + 1 // Convert to 1-12 based

      if (currentMonth >= yearAnchor) {
        // If we're past the anchor month, move to next year
        endDate = addFunction(date, billingIntervalCount)
      } else {
        // If we're before or in the anchor month, use current year
        endDate = addFunction(date, billingIntervalCount - 1)
      }

      endDate.setUTCMonth(yearAnchor - 1) // Convert anchor (1-12) to UTC month (0-11)
      endDate = endOfMonth(endDate)
    }

    const fullCycleStartAligned = alignPeriodBoundary(startDateFull, true, false)

    const fullCycleEndAligned = alignPeriodBoundary(endDateFull, true, true)

    const secondsInFullCycle = differenceInSeconds(
      fullCycleEndAligned.getTime(),
      fullCycleStartAligned.getTime()
    )

    const startResult = alignPeriodBoundary(date, options?.alignStartToDay ?? false, false)
    const endResult = alignPeriodBoundary(endDate, options?.alignEndToDay ?? false, true)

    const billableSeconds = differenceInSeconds(endResult.getTime(), startResult.getTime())

    return {
      start: startResult.getTime(),
      end: endResult.getTime(),
      secondsInCycle: secondsInFullCycle,
      billableSeconds,
      prorationFactor: billableSeconds / secondsInFullCycle,
    }
  }

  // For non-calendar aligned intervals
  endDate = addFunction(date, billingIntervalCount)

  const billableSeconds = differenceInSeconds(endDate.getTime() - 1, date.getTime())

  return {
    start: date.getTime(),
    end: endDate.getTime() - 1,
    secondsInCycle: billableSeconds,
    billableSeconds,
    prorationFactor: 1,
  }
}
