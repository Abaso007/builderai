import { nFormatter } from "@unprice/db/utils"

export function formatNumber(num: number | null | undefined, unit = ""): string {
  if (num === null || num === undefined || num === Number.POSITIVE_INFINITY) {
    return unit ? `∞ ${unit}s` : "∞"
  }
  const formatted = nFormatter(num, { digits: 1 })
  return unit ? `${formatted} ${unit}${Number(formatted) > 1 ? "s" : ""}` : formatted
}
