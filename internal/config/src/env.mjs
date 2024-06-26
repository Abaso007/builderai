import { createEnv } from "@t3-oss/env-nextjs"
import { z } from "zod"

export const env = createEnv({
  shared: {
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  },
  server: {
    NEXTJS_URL: z.preprocess(
      (str) => (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : str),
      process.env.VERCEL_URL ? z.string().min(1) : z.string().url()
    ),
  },
  client: {
    NEXT_PUBLIC_STRIPE_STD_PRODUCT_ID: z.string(),
    NEXT_PUBLIC_STRIPE_STD_MONTHLY_PRICE_ID: z.string(),
    NEXT_PUBLIC_STRIPE_PRO_PRODUCT_ID: z.string(),
    NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID: z.string(),
    NEXT_PUBLIC_APP_DOMAIN: z.preprocess(
      (str) => (process.env.NEXT_PUBLIC_VERCEL_URL ? process.env.NEXT_PUBLIC_VERCEL_URL : str),
      z.string().min(1)
    ),
  },
  // Client side variables gets destructured here due to Next.js static analysis
  // Shared ones are also included here for good measure since the behavior has been inconsistent
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_DOMAIN: process.env.NEXT_PUBLIC_APP_DOMAIN,
    NEXT_PUBLIC_STRIPE_STD_PRODUCT_ID: process.env.NEXT_PUBLIC_STRIPE_STD_PRODUCT_ID,
    NEXT_PUBLIC_STRIPE_STD_MONTHLY_PRICE_ID: process.env.NEXT_PUBLIC_STRIPE_STD_MONTHLY_PRICE_ID,
    NEXT_PUBLIC_STRIPE_PRO_PRODUCT_ID: process.env.NEXT_PUBLIC_STRIPE_PRO_PRODUCT_ID,
    NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID: process.env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
})
