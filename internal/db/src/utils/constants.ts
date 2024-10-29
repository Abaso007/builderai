export const TIER_MODES_MAP = {
  volume: {
    label: "Volume",
    description: "All units priced based on final tier reached",
  },
  graduated: {
    label: "Graduated",
    description: "Tiers applies progressively as quantity increases",
  },
} as const

export const FEATURE_TYPES_MAPS = {
  flat: {
    code: "flat",
    label: "Flat",
    description: "Fixed price for a single unit or package",
  },
  tier: {
    code: "tier",
    label: "Tier",
    description: "Offers different prices based on unit quantity",
  },
  package: {
    code: "package",
    label: "Package",
    description: "Price by package, bundle or group of units",
  },
  usage: {
    code: "usage",
    label: "Usage",
    description: "Pay as you go based on usage",
  },
} as const

export const USAGE_MODES_MAP = {
  tier: {
    code: "tier",
    label: "Tier",
    description: "Price based on quantity of units",
  },
  package: {
    code: "package",
    label: "Package",
    description: "Price by package, bundle or group of units",
  },
  unit: {
    code: "unit",
    label: "Unit",
    description: "Price by number of units, like seats, users, etc",
  },
} as const

export const AGGREGATION_METHODS_MAP = {
  sum: {
    label: "Sum",
    description: "Adds up all events values within a time period",
  },
  last_during_period: {
    label: "Last during period",
    description: "Last event value during a time period",
  },
  count: {
    label: "Count",
    description: "Counts the number of events within a time period",
  },
  max: {
    label: "Maximum",
    description: "Maximum event value within a time period",
  },
} as const

type AggregationMethod = keyof typeof AGGREGATION_METHODS_MAP
export type TierMode = keyof typeof TIER_MODES_MAP
export type UsageMode = keyof typeof USAGE_MODES_MAP
export type FeatureType = keyof typeof FEATURE_TYPES_MAPS

export const PAYMENT_PROVIDERS = ["stripe", "lemonsqueezy"] as const
export const CURRENCIES = ["USD", "EUR"] as const
export const STAGES = ["prod", "test", "dev"] as const
export const STATUS_PLAN = ["draft", "published"] as const

// this status represents the status of the subscription, it would be the same for all phases
// but phases can have different statuses than the subscription is they are not active
// for instance a phase was changed to new plan, we create a new phase with status as active
// and we leave the old phase with status changed.
export const STATUS_SUBSCRIPTION = [
  "pending", // the subscription is created but there is no phases yet
  "active", // the subscription is active
  "trialing", // the subscription is trialing
  "changed", // the subscription is changed
  "canceled", // the subscription is cancelled
  "expired", // the subscription has expired - no auto-renew
  "pending_invoice", // the subscription is pending invoice - waiting for invoice
  "past_due", // the subscription is past due - payment pending
] as const

export const STATUS_SUB_CHANGES = ["pending", "applied"] as const

// TODO: remove this
export const CHANGE_TYPE = ["upgrade", "downgrade"] as const
export const CHANGE_TYPE_SUBSCRIPTION_ITEM = ["add", "remove", "update"] as const

export const PLAN_TYPES = ["recurring"] as const
export const PLAN_BILLING_PERIODS = ["month", "year"] as const
export const ROLES_APP = ["OWNER", "ADMIN", "MEMBER"] as const
export const WHEN_TO_BILLING = ["pay_in_advance", "pay_in_arrear"] as const
export const DUE_BEHAVIOUR = ["cancel", "downgrade"] as const
export const INVOICE_STATUS = ["unpaid", "paid", "waiting", "void", "draft", "failed"] as const
export const FEATURE_VERSION_TYPES = ["feature", "addon"] as const
export const COLLECTION_METHODS = ["charge_automatically", "send_invoice"] as const

export const TIER_MODES = Object.keys(TIER_MODES_MAP) as unknown as readonly [
  TierMode,
  ...TierMode[],
]
export const USAGE_MODES = Object.keys(USAGE_MODES_MAP) as unknown as readonly [
  UsageMode,
  ...UsageMode[],
]
export const AGGREGATION_METHODS = Object.keys(AGGREGATION_METHODS_MAP) as unknown as readonly [
  AggregationMethod,
  ...AggregationMethod[],
]
export const FEATURE_TYPES = Object.keys(FEATURE_TYPES_MAPS) as unknown as readonly [
  FeatureType,
  ...FeatureType[],
]
