import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("analytics router", () => {
  it("registers getLakehouseFilePlan", () => {
    const source = readFileSync(
      path.resolve(__dirname, "router/lambda/analytics/index.ts"),
      "utf-8"
    )
    expect(source).toContain("getLakehouseFilePlan")
  })
})
