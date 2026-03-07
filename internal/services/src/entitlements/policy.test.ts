import { describe, expect, it } from "vitest"
import { deriveLimitType } from "./policy"

describe("deriveLimitType", () => {
  it("returns none when limit is missing or not finite", () => {
    expect(deriveLimitType({ limit: undefined, overageStrategy: "none" })).toBe("none")
    expect(deriveLimitType({ limit: null, overageStrategy: "always" })).toBe("none")
    expect(deriveLimitType({ limit: Number.POSITIVE_INFINITY, overageStrategy: "none" })).toBe(
      "none"
    )
  })

  it("returns soft when limit exists and overage strategy is always", () => {
    expect(deriveLimitType({ limit: 100, overageStrategy: "always" })).toBe("soft")
  })

  it("returns hard when limit exists and overage strategy is none or last-call", () => {
    expect(deriveLimitType({ limit: 100, overageStrategy: "none" })).toBe("hard")
    expect(deriveLimitType({ limit: 100, overageStrategy: "last-call" })).toBe("hard")
  })
})
