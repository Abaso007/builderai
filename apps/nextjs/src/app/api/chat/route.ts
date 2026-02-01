import { auth } from "@unprice/auth/server"
import { currencies } from "@unprice/db/utils"
import {
  type BillingConfig,
  type ConfigFeatureVersionType,
  aggregationMethodSchema,
  featureInsertBaseSchema,
  planInsertBaseSchema,
  priceSchema,
  tierModeSchema,
  typeFeatureSchema,
  usageModeSchema,
  versionInsertBaseSchema,
} from "@unprice/db/validators"
import {
  type InferUITools,
  type UIDataTypes,
  type UIMessage,
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  validateUIMessages,
} from "ai"
import type { NextRequest } from "next/server"
import { z } from "zod"
import { model } from "~/lib/ai"
import { api } from "~/trpc/server"
import { CorsOptions } from "../_enableCors"

export const maxDuration = 30
export const preferredRegion = ["fra1"]

// =============================================================================
// Helper: Create Dinero price object for the AI
// =============================================================================
const createPriceSchema = z
  .object({
    amount: priceSchema.describe("Price amount as string, e.g., '9.99', '100', '0.50'"),
    currency: z.enum(["USD", "EUR"]).describe("Currency code: USD or EUR"),
  })
  .describe("Price configuration with amount and currency")

// Helper to convert simple price to dinero format
function toDineroPrice(amount: string, currency: "USD" | "EUR") {
  const currencyConfig =
    currency === "USD"
      ? { code: "USD", base: 10, exponent: 2 }
      : { code: "EUR", base: 10, exponent: 2 }

  const precision = amount.split(".")[1]?.length ?? 2
  const amountNum = Math.round(Number(amount) * 10 ** precision)

  return {
    dinero: {
      amount: amountNum,
      currency: currencyConfig,
      scale: precision,
    },
    displayAmount: amount,
  }
}

// =============================================================================
// Tool: Create Feature
// =============================================================================
const createFeatureInputSchema = z.object({
  title: featureInsertBaseSchema.shape.title.describe(
    "Human-readable feature name (1-50 chars). Will be UPPERCASED. Examples: 'API Calls', 'Team Members'"
  ),
  slug: featureInsertBaseSchema.shape.slug.describe(
    "URL-friendly identifier (lowercase, hyphens). Examples: 'api-calls', 'team-members'"
  ),
  description: featureInsertBaseSchema.shape.description.describe(
    "Detailed explanation of what this feature provides"
  ),
  unit: featureInsertBaseSchema.shape.unit.describe(
    "Unit of measurement. Examples: 'calls', 'GB', 'seats', 'tokens', 'requests'"
  ),
})

const createFeatureTool = tool({
  description:
    "Create a new feature for pricing plans. Features are the building blocks of your pricing - they represent capabilities, limits, or usage metrics. Examples: 'API Calls', 'Team Members', 'Storage GB'. The title will be automatically UPPERCASED. The slug should be URL-friendly (lowercase with hyphens). ALWAYS create features BEFORE creating plan version features.",
  inputSchema: createFeatureInputSchema,
  async *execute({ title, slug, description, unit }) {
    yield { state: "creating" as const, title }

    try {
      const result = await api.features.create({
        title: title.toUpperCase(),
        slug,
        description,
        unit,
      })

      yield {
        state: "created" as const,
        feature: result.feature,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to create feature",
      }
    }
  },
})

// =============================================================================
// Tool: List Features
// =============================================================================
const listFeaturesTool = tool({
  description:
    "List all features that have been created for this project. Use BEFORE creating plan version features to get feature IDs. Returns feature id, title, slug, and unit.",
  inputSchema: z.object({}),
  async *execute() {
    yield { state: "loading" as const }

    try {
      const result = await api.features.searchBy({ search: "" })

      yield {
        state: "ready" as const,
        features: result.features,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to list features",
      }
    }
  },
})

// =============================================================================
// Tool: Get Plan by Slug
// =============================================================================
const getPlanBySlugTool = tool({
  description:
    "Check if a plan with the given slug already exists. Use this BEFORE creating a plan to avoid duplicates. If plan exists, create a new plan VERSION instead of a new plan.",
  inputSchema: z.object({
    slug: z.string().describe("The plan slug to search for, e.g., 'pro', 'starter', 'enterprise'"),
  }),
  async *execute({ slug }) {
    yield { state: "loading" as const }

    try {
      const result = await api.plans.getBySlug({ slug })

      yield {
        state: "found" as const,
        plan: result.plan,
      }
    } catch (error) {
      // Plan not found is expected - not an error
      if (error instanceof Error && error.message.includes("not found")) {
        yield {
          state: "not_found" as const,
          slug,
        }
      } else {
        yield {
          state: "error" as const,
          error: error instanceof Error ? error.message : "Failed to get plan",
        }
      }
    }
  },
})

// =============================================================================
// Tool: Create Plan
// =============================================================================

const createPlanTool = tool({
  description:
    "Create a new pricing plan CONTAINER. A plan is the parent that holds multiple plan VERSIONS. The slug identifies the plan family. After creating a plan, you MUST create a plan VERSION to define the actual pricing. Check if plan exists first with getPlanBySlug - if it exists, just create a new version.",
  inputSchema: planInsertBaseSchema,
  async *execute({ title, slug, description, defaultPlan, enterprisePlan }) {
    yield { state: "creating" as const, slug }

    try {
      const result = await api.plans.create({
        title: title.toUpperCase(),
        slug: slug.toLowerCase(),
        description: description || `${slug} plan`,
        defaultPlan,
        enterprisePlan,
      })

      yield {
        state: "created" as const,
        plan: result.plan,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to create plan",
      }
    }
  },
})

// =============================================================================
// Tool: List Plans
// =============================================================================
const listPlansTool = tool({
  description:
    "List all plans and their versions for this project. Use to see existing plans before creating new ones. Returns plan id, slug, and version information.",
  inputSchema: z.object({
    published: z.boolean().optional().describe("If true, only return published plan versions"),
  }),
  async *execute({ published }) {
    yield { state: "loading" as const }

    try {
      const result = await api.plans.listByActiveProject({ published })

      yield {
        state: "ready" as const,
        plans: result.plans,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to list plans",
      }
    }
  },
})

// =============================================================================
// Tool: Create Plan Version
// =============================================================================
const createPlanVersionInputSchema = z.object({
  planId: z.string().describe("The ID of the parent plan (get from createPlan or listPlans)"),
  title: versionInsertBaseSchema.shape.title.describe(
    "Human-readable plan version title (1-50 chars). Will be UPPERCASED. Examples: 'Starter', 'Pro', 'Enterprise"
  ),
  description: versionInsertBaseSchema.shape.description.describe(
    "Description of this plan version explaining what's included"
  ),
  currency: z.enum(["USD", "EUR"]).describe("Currency for all pricing in this version"),
  billingPeriod: z
    .enum(["monthly", "yearly", "onetime"])
    .describe(
      "Billing frequency: 'monthly' (charged every month), 'yearly' (charged annually), 'onetime' (one-time purchase)"
    ),
  trialDays: versionInsertBaseSchema.shape.trialUnits,
})

const createPlanVersionTool = tool({
  description:
    "Create a new VERSION of a plan with billing configuration. Plan versions define the actual pricing terms (currency, billing period, trial). After creating a plan version, add features using createPlanVersionFeature. A plan version starts as 'draft'.",
  inputSchema: createPlanVersionInputSchema,
  async *execute({ planId, title, description, currency, billingPeriod, trialDays }) {
    yield { state: "creating" as const, planId }

    try {
      // Map simple billing period to full billing config
      let billingConfig: BillingConfig
      if (billingPeriod === "monthly") {
        billingConfig = {
          name: "monthly",
          billingInterval: "month",
          billingIntervalCount: 1,
          billingAnchor: "dayOfCreation",
          planType: "recurring",
        }
      } else if (billingPeriod === "yearly") {
        billingConfig = {
          name: "yearly",
          billingInterval: "year",
          billingIntervalCount: 1,
          billingAnchor: "dayOfCreation",
          planType: "recurring",
        }
      } else {
        billingConfig = {
          name: "onetime",
          billingInterval: "onetime",
          billingIntervalCount: 1,
          billingAnchor: "dayOfCreation",
          planType: "onetime",
        }
      }

      const result = await api.planVersions.create({
        planId,
        title: title?.toUpperCase() ?? "",
        description: description ?? "",
        currency,
        billingConfig,
        paymentProvider: "sandbox",
        paymentMethodRequired: true,
        whenToBill: "pay_in_advance",
        autoRenew: billingPeriod !== "onetime",
        trialUnits: trialDays ?? 0,
      })

      yield {
        state: "created" as const,
        planVersion: result.planVersion,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to create plan version",
      }
    }
  },
})

// =============================================================================
// Tool: Create Plan Version Feature (with all 4 pricing types)
// =============================================================================

// Tier definition for AI
const tierInputSchema = z.object({
  firstUnit: z
    .number()
    .int()
    .min(1)
    .describe("Starting unit for this tier (inclusive). First tier must start at 1."),
  lastUnit: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe("Ending unit for this tier (inclusive). Use null for the final unlimited tier."),
  unitPrice: createPriceSchema.describe("Price per unit within this tier"),
  flatPrice: createPriceSchema.optional().describe("Optional fixed fee for entering this tier"),
})

const createPlanVersionFeatureInputSchema = z.object({
  planVersionId: z
    .string()
    .describe("The ID of the plan version to add this feature to (get from createPlanVersion)"),
  featureId: z
    .string()
    .describe("The ID of the feature to add (get from createFeature or listFeatures)"),
  featureType: typeFeatureSchema,

  // Flat pricing config
  flatPrice: createPriceSchema
    .optional()
    .describe("For 'flat' type: the fixed price. For 'package' type: price per package."),

  // Tier pricing config
  tierMode: tierModeSchema
    .optional()
    .describe(
      "For 'tier' type: 'volume' (all units at the tier price) or 'graduated' (each unit priced at its tier)"
    ),
  tiers: z
    .array(tierInputSchema)
    .optional()
    .describe("For 'tier' type: array of pricing tiers. Tiers must be consecutive with no gaps."),

  // Usage pricing config
  usageMode: usageModeSchema
    .optional()
    .describe(
      "For 'usage' type: 'unit' (price per unit), 'tier' (tiered usage), 'package' (usage packages)"
    ),
  usagePrice: createPriceSchema
    .optional()
    .describe("For 'usage' with usageMode 'unit' or 'package': price per unit/package"),
  usageTiers: z
    .array(tierInputSchema)
    .optional()
    .describe("For 'usage' with usageMode 'tier': usage-based pricing tiers"),

  // Package pricing config
  packageUnits: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("For 'package' type or usage 'package' mode: number of units in each package"),

  // Common options
  defaultQuantity: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Default quantity included with subscription. Example: 5 for '5 seats included'."),
  limit: z
    .number()
    .int()
    .optional()
    .describe("Maximum usage allowed per billing period. Leave undefined for unlimited."),
  hidden: z
    .boolean()
    .optional()
    .describe("If true, hide this feature from pricing displays. Useful for internal features."),
  aggregationMethod: aggregationMethodSchema.optional(),
})

const createPlanVersionFeatureTool = tool({
  description: `Add a feature with pricing configuration to a plan version. Supports 4 pricing types:

1. FLAT: Fixed price regardless of usage. Use for included features like "Basic Support".
   Required: flatPrice

2. TIER: Volume-based pricing with different rates at different volumes.
   Required: tierMode ('volume' or 'graduated'), tiers array
   - Volume: All units priced at the tier they fall into
   - Graduated: Each unit priced at its respective tier rate

3. USAGE: Pay-as-you-go metered billing based on actual consumption.
   Required: usageMode ('unit', 'tier', or 'package')
   - Unit: Simple per-unit pricing (usagePrice required)
   - Tier: Tiered usage pricing (usageTiers required)
   - Package: Usage packages (usagePrice + packageUnits required)

4. PACKAGE: Bundles of units at a fixed price per bundle.
   Required: flatPrice, packageUnits

If a feature already exists in the plan version, it will not be duplicated.`,
  inputSchema: createPlanVersionFeatureInputSchema,
  async *execute(input) {
    yield { state: "creating" as const, featureId: input.featureId }

    try {
      const { planVersion } = await api.planVersions.getById({ id: input.planVersionId })

      if (!planVersion?.billingConfig) {
        throw new Error("Plan version billing config is required")
      }

      // Build the config based on feature type
      let config: ConfigFeatureVersionType = {
        price: {
          dinero: {
            amount: 0,
            currency: currencies[planVersion.currency as keyof typeof currencies],
            scale: 2,
          },
          displayAmount: "0",
        },
      }

      switch (input.featureType) {
        case "flat": {
          if (!input.flatPrice) {
            throw new Error("flatPrice is required for flat pricing type")
          }
          config = {
            price: toDineroPrice(input.flatPrice.amount, input.flatPrice.currency),
          }
          break
        }

        case "tier": {
          if (!input.tierMode || !input.tiers || input.tiers.length === 0) {
            throw new Error("tierMode and tiers are required for tier pricing type")
          }
          config = {
            tierMode: input.tierMode,
            tiers: input.tiers.map((t) => ({
              firstUnit: t.firstUnit,
              lastUnit: t.lastUnit,
              unitPrice: toDineroPrice(t.unitPrice.amount, t.unitPrice.currency),
              flatPrice: t.flatPrice
                ? toDineroPrice(t.flatPrice.amount, t.flatPrice.currency)
                : toDineroPrice("0", t.unitPrice.currency),
            })),
          }
          break
        }

        case "usage": {
          if (!input.usageMode) {
            throw new Error("usageMode is required for usage pricing type")
          }

          if (input.usageMode === "unit") {
            if (!input.usagePrice) {
              throw new Error("usagePrice is required for usage unit mode")
            }
            config = {
              usageMode: "unit",
              price: toDineroPrice(input.usagePrice.amount, input.usagePrice.currency),
            }
          } else if (input.usageMode === "tier") {
            if (!input.usageTiers || input.usageTiers.length === 0) {
              throw new Error("usageTiers are required for usage tier mode")
            }
            config = {
              usageMode: "tier",
              tierMode: input.tierMode ?? "graduated",
              tiers: input.usageTiers.map((t) => ({
                firstUnit: t.firstUnit,
                lastUnit: t.lastUnit,
                unitPrice: toDineroPrice(t.unitPrice.amount, t.unitPrice.currency),
                flatPrice: t.flatPrice
                  ? toDineroPrice(t.flatPrice.amount, t.flatPrice.currency)
                  : toDineroPrice("0", t.unitPrice.currency),
              })),
            }
          } else if (input.usageMode === "package") {
            if (!input.usagePrice || !input.packageUnits) {
              throw new Error("usagePrice and packageUnits are required for usage package mode")
            }
            config = {
              usageMode: "package",
              price: toDineroPrice(input.usagePrice.amount, input.usagePrice.currency),
              units: input.packageUnits,
            }
          }
          break
        }

        case "package": {
          if (!input.flatPrice || !input.packageUnits) {
            throw new Error("flatPrice and packageUnits are required for package pricing type")
          }
          config = {
            price: toDineroPrice(input.flatPrice.amount, input.flatPrice.currency),
            units: input.packageUnits,
          }
          break
        }
      }

      // Check if feature already exists
      const existingFeatures = await api.planVersionFeatures.getByPlanVersionId({
        planVersionId: input.planVersionId,
      })

      const existing = existingFeatures.planVersionFeatures.find(
        (f) => f.featureId === input.featureId
      )

      if (existing) {
        yield {
          state: "created" as const,
          planVersionFeature: existing,
        }
        return
      }

      const result = await api.planVersionFeatures.create({
        planVersionId: input.planVersionId,
        featureId: input.featureId,
        featureType: input.featureType,
        config: config,
        billingConfig: planVersion.billingConfig,
        resetConfig: {
          name: planVersion.billingConfig.name,
          resetInterval: planVersion.billingConfig.billingInterval,
          resetIntervalCount: planVersion.billingConfig.billingIntervalCount,
          resetAnchor: planVersion.billingConfig.billingAnchor,
          planType: planVersion.billingConfig.planType,
        },
        defaultQuantity: input.defaultQuantity ?? 1,
        limit: input.limit,
        aggregationMethod:
          input.featureType === "usage" ? (input.aggregationMethod ?? "sum") : "none",
        metadata: {
          hidden: input.hidden ?? false,
        },
        order: 1024,
      })

      yield {
        state: "created" as const,
        planVersionFeature: result.planVersionFeature,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to create plan version feature",
      }
    }
  },
})

// =============================================================================
// Tool: List Plan Version Features
// =============================================================================
const listPlanVersionFeaturesTool = tool({
  description:
    "List all features attached to a specific plan version. Use to check what features are already configured before adding more.",
  inputSchema: z.object({
    planVersionId: z.string().describe("The ID of the plan version to list features for"),
  }),
  async *execute({ planVersionId }) {
    yield { state: "loading" as const }

    try {
      const result = await api.planVersionFeatures.getByPlanVersionId({ planVersionId })

      yield {
        state: "ready" as const,
        features: result.planVersionFeatures,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to list plan version features",
      }
    }
  },
})

// =============================================================================
// Tool: Get Plan Version by ID
// =============================================================================
const getPlanVersionByIdTool = tool({
  description:
    "Get detailed information about a specific plan version including all its features and pricing. Use to display the final pricing card.",
  inputSchema: z.object({
    planVersionId: z.string().describe("The ID of the plan version to get"),
  }),
  async *execute({ planVersionId }) {
    yield { state: "loading" as const }

    try {
      const result = await api.planVersions.getById({ id: planVersionId })

      yield {
        state: "ready" as const,
        planVersion: result.planVersion,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to get plan version",
      }
    }
  },
})

// =============================================================================
// All Tools
// =============================================================================
const tools = {
  // Features
  createFeature: createFeatureTool,
  listFeatures: listFeaturesTool,
  // Plans
  getPlanBySlug: getPlanBySlugTool,
  createPlan: createPlanTool,
  listPlans: listPlansTool,
  // Plan Versions
  createPlanVersion: createPlanVersionTool,
  getPlanVersionById: getPlanVersionByIdTool,
  // Plan Version Features
  createPlanVersionFeature: createPlanVersionFeatureTool,
  listPlanVersionFeatures: listPlanVersionFeaturesTool,
} as const

export type PricingChatMessage = UIMessage<never, UIDataTypes, InferUITools<typeof tools>>

// =============================================================================
// System Prompt
// =============================================================================
const systemPrompt = `You are an expert in SaaS pricing and monetization strategy. Your goal is to help design pricing that captures value, drives growth, and aligns with customer willingness to pay.

## CORE CONCEPTS

1. **Feature**: The building block - represents a capability (e.g., "API Calls", "Team Members", "Storage").
   - Features have a title, slug (lowercase-hyphens), and unit.
   - Try to figure out the simplest name of the feature, like if the feature is unlimited tokens, the name should be tokens. The unlimited part is configured in the plan version feature.
   - Create features FIRST before adding them to plans.

2. **Plan**: A container/parent that groups related plan versions (e.g., "starter", "pro", "enterprise").
   - The slug identifies the plan family (lowercase-hyphens).
   - The title is the display name of the plan.
   - Check if plan exists with getPlanBySlug before creating.

3. **Plan Version**: The actual pricing configuration for a plan.
   - Defines currency, billing period (monthly/yearly/onetime), trial days.
   - A plan can have multiple versions (v1, v2, etc.).
   - Starts as "draft" - the user will publish the plan version themselves.

4. **Plan Version Feature**: A feature attached to a plan version with pricing config.
   - This is where you define HOW the feature is priced.
   - for the base features of the plan you can hide them from the UI by setting the hidden flag to true. So features like pay-access or free-access are not visible in the pricing card.

## PRICING TYPES (4 options)

1. **FLAT**: Fixed price regardless of usage.
   - Best for: Binary features (enabled/disabled), unlocking capabilities.
   - Example: "SSO", "Custom Domain", "24/7 Support".
   - **DO NOT** use for countable items (like "100 emails") - use USAGE instead.
   - Config: flatPrice required

2. **TIER**: Volume-based pricing with different rates at different volumes.
   - Best for: Discounts at scale, enterprise pricing.
   - Two modes:
     - Volume: All units priced at the tier they fall into
     - Graduated: Each unit priced at its respective tier
   - Example: "1-100 users: $10/user, 101-500: $8/user, 500+: $5/user"
   - Config: tierMode + tiers array required

3. **USAGE**: Pay-as-you-go metered billing or included usage limits.
   - Best for: API calls, seats, storage, emails, tokens.
   - **ALWAYS** use this for features with limits/quantities (e.g., "100 calls", "5 seats").
   - Three modes:
     - Unit: Simple per-unit pricing (or 0 price if included)
     - Tier: Tiered usage pricing
     - Package: Usage sold in packages
   - Example: "$0.001 per API call" or "1000 tokens for $0.10" or "5 Seats Included" (price 0, limit 5)
   - Config: usageMode required, plus usagePrice/usageTiers/packageUnits

4. **PACKAGE**: Bundles of units at a fixed price.
   - Best for: Credits, token packs, bulk purchases.
   - Example: "100 credits for $10"
   - Config: flatPrice + packageUnits required

## AGGREGATION METHODS (for USAGE type features)

Aggregation determines HOW usage events are calculated for billing. Choose based on feature behavior:

### Period-Scoped (Resets each billing cycle)

1. **sum**: Adds up all event values within the current billing period.
   - Best for: API calls, tokens consumed, emails sent, bandwidth used.
   - Example: Customer sends 1000 API calls this month → usage = 1000
   - Resets to 0 at the start of each new billing cycle.

2. **count**: Counts the NUMBER of events (ignores event values).
   - Best for: Number of operations, transactions, requests.
   - Example: Customer makes 50 transactions → usage = 50
   - Each event adds +1 regardless of its value.

3. **max**: Takes the maximum event value within the period.
   - Best for: Peak concurrent users, max storage reached, highest tier accessed.
   - Example: Peak users during month was 150 → usage = 150
   - Only the highest value matters, not the sum.

4. **last_during_period**: Uses the last reported value in the period.
   - Best for: Seat counts, active users, storage snapshots.
   - Example: Customer ends month with 10 seats → usage = 10
   - Each report replaces the previous value.

### Lifetime-Scoped (Never Resets - Accumulation)

5. **sum_all**: Adds up all event values EVER (across all billing cycles).
   - Best for: Total credits purchased, lifetime data processed, cumulative usage.
   - Example: Customer has used 50,000 API calls total since signup → usage = 50,000
   - NEVER resets, keeps accumulating forever.

6. **count_all**: Counts total number of events EVER.
   - Best for: Lifetime transaction count, total operations performed.
   - Example: Customer has made 500 transactions since signup → usage = 500
   - NEVER resets, keeps counting forever.

7. **max_all**: Maximum event value EVER recorded.
   - Best for: Highest tier ever reached, peak usage ever, record high.
   - Example: Customer's highest concurrent users ever was 200 → usage = 200
   - NEVER resets, only updates if a higher value is reported.

### Choosing the Right Aggregation

| Use Case | Aggregation | Why |
|----------|-------------|-----|
| API calls per month | sum | Reset each cycle, add up all calls |
| Seat-based billing | last_during_period | Current seat count, not cumulative |
| Peak concurrent users | max | Only charge for the peak |
| Lifetime credits used | sum_all | Track total ever used |
| Storage used | last_during_period | Current snapshot, not cumulative |
| Requests this period | count | Count events, ignore values |

### Important Notes

- **FLAT and PACKAGE types**: Aggregation method is NOT used (set to 'none').
- **USAGE type**: Aggregation method is REQUIRED - choose based on billing model.
- **Period vs Lifetime**: Period-scoped resets each billing cycle. Lifetime-scoped accumulates forever.
- **Default choice**: For most metered features (API calls, tokens), use **sum**.
- **For seat-based**: Use **last_during_period** to bill current seat count.

## DECISION GUIDE

- **Has a number?** (e.g., "100 calls", "5 users", "10GB") -> Use **USAGE** (metered).
  - If included in base price: Set usagePrice to 0, set limit/defaultQuantity.
  - If paid: Set usagePrice > 0.
- **Yes/No feature?** (e.g., "SSO", "Analytics") -> Use **FLAT**.
- **Complex tiers?** -> Use **TIER**.
- **Prepaid bundles?** -> Use **PACKAGE**.

## WORKFLOW

Always follow this order:

1. **Create Features** first (if they don't exist)
   - Use listFeatures to check existing features
   - Create with createFeature

2. **Check if Plan exists**
   - Use getPlanBySlug to check
   - If exists, skip to step 4 (create new version)
   - If not exists, create with createPlan

3. **Create Plan** (if needed)
   - Use createPlan with slug, description
   - Mark defaultPlan=true for starter/free tier
   - Mark enterprisePlan=true for contact-us plans

4. **Create Plan Version**
   - Use createPlanVersion with planId, currency, billingPeriod
   - Add trial days if needed

5. **Add Features to Plan Version**
   - Use createPlanVersionFeature for each feature
   - Choose appropriate pricing type
   - Set limits and defaults as needed

6. **Review Plan Version**
   - Use getPlanVersionById to show the final pricing card.
   - The user will publish the plan themselves.

## BEST PRACTICES

- Use descriptive slugs: "pro", "starter", "enterprise", "api-calls", "team-members"
- For trials: 7-14 days is common
- Set the aggregation method based on feature behavior:
  - FLAT/PACKAGE types: Use 'none' (aggregation not applicable)
  - USAGE type with consumables (API calls, tokens, emails): Use 'sum'
  - USAGE type with seats/licenses: Use 'last_during_period'
  - USAGE type with peak billing: Use 'max'
  - Lifetime tracking (total credits ever): Use 'sum_all', 'count_all', or 'max_all'
- For limits: Set them to prevent abuse, leave undefined for unlimited
- Suggest appropriate pricing based on industry standards

## IMPORTANT

- Feature titles should be descriptive and unique. Capitalize the first letter of each word
- Plan slugs should be lowercase with hyphens, avoid using special characters or spaces
- Always create features before adding them to plan versions
- Check for existing plans before creating new ones
- Always create a feature pay-access or free-access with type flat and price the base price of the plan. This is the way can identify and verify access without refactoring the code.
- A plan version must have at least one feature`

// =============================================================================
// Handler
// =============================================================================
const handler = auth(async (req: NextRequest) => {
  const body = await req.json()

  const messages = await validateUIMessages<PricingChatMessage>({
    messages: body.messages,
    tools,
  })

  const result = streamText({
    model,
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(15),
    tools,
  })

  return result.toUIMessageStreamResponse()
})

export { handler as GET, CorsOptions as OPTIONS, handler as POST }
