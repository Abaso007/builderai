import { describe, expect, it } from "vitest"

import { eventInsertBaseSchema } from "./events"

describe("eventInsertBaseSchema", () => {
  it("accepts lowercase SDK-style slugs and reusable properties", () => {
    const result = eventInsertBaseSchema.safeParse({
      name: "AI Completion",
      slug: "llm_completion",
      availableProperties: ["input_tokens", "output_tokens"],
    })

    expect(result.success).toBe(true)
  })

  it("rejects invalid event slugs", () => {
    const result = eventInsertBaseSchema.safeParse({
      name: "AI Completion",
      slug: "LLM Completion",
      availableProperties: ["input_tokens"],
    })

    expect(result.success).toBe(false)
  })
})
