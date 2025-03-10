import { DEFAULT_INTERVAL, INTERVAL_KEYS } from "@unprice/tinybird"
import {
  createSearchParamsCache,
  parseAsInteger,
  parseAsString,
  parseAsStringEnum,
} from "nuqs/server"

export const filtersDataTableParsers = {
  page: parseAsInteger.withDefault(1),
  page_size: parseAsInteger.withDefault(10),
  to: parseAsInteger,
  from: parseAsInteger,
  search: parseAsString,
}

export const intervalParser = {
  interval: parseAsStringEnum(INTERVAL_KEYS).withDefault(DEFAULT_INTERVAL),
}

export const intervalParserCache = createSearchParamsCache(intervalParser)
export const filtersDataTableCache = createSearchParamsCache(filtersDataTableParsers)
