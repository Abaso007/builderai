import { DEFAULT_INTERVAL, INTERVAL_KEYS } from "@unprice/analytics"
import { createLoader, parseAsInteger, parseAsString, parseAsStringEnum } from "nuqs/server"

export const filtersDataTableParsers = {
  page: parseAsInteger.withDefault(1),
  page_size: parseAsInteger.withDefault(10),
  to: parseAsInteger,
  from: parseAsInteger,
  search: parseAsString,
  intervalDays: parseAsInteger.withDefault(7),
}

export const intervalParser = {
  intervalFilter: parseAsStringEnum(INTERVAL_KEYS).withDefault(DEFAULT_INTERVAL),
}

export const realtimeIntervalValues = [300, 3600, 86400, 604800] as const
export type RealtimeWindowSeconds = (typeof realtimeIntervalValues)[number]

export const realtimeIntervalKeys = realtimeIntervalValues.map((value) => String(value)) as string[]

export const realtimeIntervalParser = {
  realtimeInterval: parseAsStringEnum(realtimeIntervalKeys).withDefault("300"),
}

export const pageParser = {
  pageId: parseAsString.withDefault("all"),
}

export const intervalParams = createLoader(intervalParser)
export const realtimeIntervalParams = createLoader(realtimeIntervalParser)
export const dataTableParams = createLoader(filtersDataTableParsers)
export const pageParams = createLoader(pageParser)
