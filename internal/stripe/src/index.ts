import { Stripe } from "stripe"

import { env } from "./env.mjs"

export * from "./webhooks"

export { Stripe as StripeClient } from "stripe"

export { Stripe }

export const stripe = new Stripe(env.STRIPE_API_KEY, {
  apiVersion: "2023-10-16",
  typescript: true,
})
