import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { env } from "~/env"

const openrouter = createOpenRouter({
  apiKey: env.OPENROUTER_API_KEY,
  headers: {
    "HTTP-Referer": "https://unprice.dev",
    "X-Title": "unprice",
  },
})

export const model = openrouter("openai/o4-mini")
