import type { OverageStrategy } from "@unprice/db/validators"

export type LimitType = "hard" | "soft" | "none"

export function deriveLimitType(params: {
  limit: number | null | undefined
  overageStrategy: OverageStrategy | null | undefined
}): LimitType {
  if (typeof params.limit !== "number" || !Number.isFinite(params.limit)) {
    return "none"
  }

  return params.overageStrategy === "always" ? "soft" : "hard"
}
