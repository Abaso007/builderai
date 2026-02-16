export const LAKEHOUSE_SOURCES = [
  "usage",
  "verification",
  "metadata",
  "entitlement_snapshot",
] as const

export type LakehouseSource = (typeof LAKEHOUSE_SOURCES)[number]

export const LAKEHOUSE_SCHEMA_VERSION = 2

export const LAKEHOUSE_INTERNAL_METADATA_KEYS = [
  "cost",
  "rate",
  "rate_amount",
  "rate_currency",
  "rate_unit_size",
  "usage",
  "remaining",
] as const
