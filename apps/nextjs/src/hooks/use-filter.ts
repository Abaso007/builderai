"use client"
import { prepareInterval, preparePage } from "@unprice/analytics"
import { useQueryStates } from "nuqs"
import { useMemo } from "react"
import {
  type RealtimeWindowSeconds,
  intervalParser,
  pageParser,
  realtimeIntervalParser,
} from "~/lib/searchParams"

export function useIntervalFilter() {
  const [intervalFilter, setIntervalFilter] = useQueryStates(intervalParser, {
    history: "replace", // push or replace -> push will add a new entry to the history, replace will replace the current entry
    shallow: true,
    scroll: false, // scroll to the top of the page when the filter changes
    clearOnDefault: true,
    throttleMs: 1000, // throttle the query state changes to 1 second
  })

  const parsedInterval = useMemo(() => {
    return prepareInterval(intervalFilter.intervalFilter)
  }, [intervalFilter.intervalFilter])

  return [parsedInterval, setIntervalFilter] as const
}

export function usePageFilter() {
  const [pageFilter, setPageFilter] = useQueryStates(pageParser, {
    history: "replace",
    shallow: true,
    scroll: false,
    clearOnDefault: true,
    throttleMs: 1000, // throttle the query state changes to 1 second
  })

  const parsedPage = useMemo(() => {
    return preparePage(pageFilter.pageId)
  }, [pageFilter.pageId])

  return [parsedPage, setPageFilter] as const
}

export function useRealtimeIntervalFilter() {
  const [realtimeIntervalFilter, setRealtimeIntervalFilter] = useQueryStates(
    realtimeIntervalParser,
    {
      history: "replace",
      shallow: true,
      scroll: false,
      clearOnDefault: true,
      throttleMs: 1000,
    }
  )

  const parsedWindowSeconds = useMemo<RealtimeWindowSeconds>(() => {
    return Number(realtimeIntervalFilter.realtimeInterval) as RealtimeWindowSeconds
  }, [realtimeIntervalFilter.realtimeInterval])

  return [parsedWindowSeconds, setRealtimeIntervalFilter] as const
}
