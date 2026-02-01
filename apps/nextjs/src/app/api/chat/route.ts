import { auth } from "@unprice/auth/server"
import { currencies } from "@unprice/db/utils"
import {
  type BillingConfig,
  type ConfigFeatureVersionType,
  featureInsertBaseSchema,
  planInsertBaseSchema,
  typeFeatureSchema,
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
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, "Price must be a number with up to 2 decimal places")
      .describe("Price amount as string, e.g., '9.99', '100', '0.50'"),
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
const createPlanInputSchema = z.object({
  title: planInsertBaseSchema.shape.title.describe(
    "Human-readable plan title (1-50 chars). Will be UPPERCASED. Examples: 'Starter', 'Pro', 'Enterprise'"
  ),
  slug: planInsertBaseSchema.shape.slug.describe(
    "URL-friendly plan identifier (lowercase, hyphens). Examples: 'starter', 'pro', 'enterprise'. This becomes the parent for all plan versions."
  ),
  description: z
    .string()
    .optional()
    .describe("Description of the plan explaining its target audience and value proposition"),
  defaultPlan: z
    .boolean()
    .optional()
    .describe(
      "Whether this is the default plan shown to new users (only one plan can be default). Use for your 'Starter' or 'Free' tier."
    ),
  enterprisePlan: z
    .boolean()
    .optional()
    .describe(
      "Whether this is an enterprise plan with custom pricing. Enterprise plans show 'Contact Us' instead of a price."
    ),
})

const createPlanTool = tool({
  description:
    "Create a new pricing plan CONTAINER. A plan is the parent that holds multiple plan VERSIONS. The slug identifies the plan family. After creating a plan, you MUST create a plan VERSION to define the actual pricing. Check if plan exists first with getPlanBySlug - if it exists, just create a new version.",
  inputSchema: createPlanInputSchema,
  async *execute({ slug, description, defaultPlan, enterprisePlan, title }) {
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
  title: z
    .string()
    .optional()
    .describe("Title of the plan version, normally the same as the plan title"),
  description: z
    .string()
    .optional()
    .describe("Description of this plan version explaining what's included"),
  currency: z.enum(["USD", "EUR"]).describe("Currency for all pricing in this version"),
  billingPeriod: z
    .enum(["monthly", "yearly", "onetime"])
    .describe(
      "Billing frequency: 'monthly' (charged every month), 'yearly' (charged annually), 'onetime' (one-time purchase)"
    ),
  trialDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe("Number of trial days before billing starts. 0 or omit for no trial."),
})

const createPlanVersionTool = tool({
  description:
    "Create a new VERSION of a plan with billing configuration. Plan versions define the actual pricing terms (currency, billing period, trial). After creating a plan version, add features using createPlanVersionFeature. A plan version starts as 'draft' - use publishPlanVersion when ready.",
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
        title: title ?? "",
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
  tierMode: z
    .enum(["volume", "graduated"])
    .optional()
    .describe(
      "For 'tier' type: 'volume' (all units at the tier price) or 'graduated' (each unit priced at its tier)"
    ),
  tiers: z
    .array(tierInputSchema)
    .optional()
    .describe("For 'tier' type: array of pricing tiers. Tiers must be consecutive with no gaps."),

  // Usage pricing config
  usageMode: z
    .enum(["unit", "tier", "package"])
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
  aggregationMethod: z
    .enum(["sum", "count", "max", "last_during_period"])
    .optional()
    .describe(
      "For 'usage' type: how to aggregate usage events. 'sum' (total values), 'count' (count events), 'max' (highest value)"
    ),
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
// Tool: Publish Plan Version
// =============================================================================
const publishPlanVersionTool = tool({
  description:
    "Publish a plan version to make it available to customers. Once published, the plan version cannot be modified (create a new version instead). Only publish when all features have been added.",
  inputSchema: z.object({
    planVersionId: z.string().describe("The ID of the plan version to publish"),
  }),
  async *execute({ planVersionId }) {
    yield { state: "publishing" as const, planVersionId }

    try {
      const result = await api.planVersions.publish({ id: planVersionId })

      yield {
        state: "published" as const,
        planVersion: result.planVersion,
      }
    } catch (error) {
      yield {
        state: "error" as const,
        error: error instanceof Error ? error.message : "Failed to publish plan version",
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
  publishPlanVersion: publishPlanVersionTool,
  // Plan Version Features
  createPlanVersionFeature: createPlanVersionFeatureTool,
  listPlanVersionFeatures: listPlanVersionFeaturesTool,
} as const

export type PricingChatMessage = UIMessage<never, UIDataTypes, InferUITools<typeof tools>>

// =============================================================================
// System Prompt
// =============================================================================
const systemPrompt = `You are an expert SaaS pricing consultant helping users create complete pricing plans.

## CORE CONCEPTS

1. **Feature**: The building block - represents a capability (e.g., "API Calls", "Team Members", "Storage").
   - Features have a title (UPPERCASED), slug (lowercase-hyphens), and unit.
   - Create features FIRST before adding them to plans.

2. **Plan**: A container/parent that groups related plan versions (e.g., "starter", "pro", "enterprise").
   - The slug identifies the plan family.
   - Check if plan exists with getPlanBySlug before creating.

3. **Plan Version**: The actual pricing configuration for a plan.
   - Defines currency, billing period (monthly/yearly/onetime), trial days.
   - A plan can have multiple versions (v1, v2, etc.).
   - Starts as "draft" - must be published to be available to customers.

4. **Plan Version Feature**: A feature attached to a plan version with pricing config.
   - This is where you define HOW the feature is priced.

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

6. **Publish Plan Version** (when ready)
   - Use publishPlanVersion to make it live
   - After publishing, use getPlanVersionById to show the final pricing

## BEST PRACTICES

- Use descriptive slugs: "pro", "starter", "enterprise", "api-calls", "team-members"
- For trials: 7-14 days is common
- For usage: Always set aggregationMethod (sum for values, count for events)
- For limits: Set them to prevent abuse, leave undefined for unlimited
- Always confirm with the user before publishing
- Suggest appropriate pricing based on industry standards

## IMPORTANT

- Feature titles are automatically UPPERCASED
- Plan slugs should be lowercase with hyphens
- Always create features before adding them to plan versions
- Check for existing plans before creating new ones
- A plan version must have at least one feature before publishing`

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
