import type { LakehouseSource } from "./source"

export const LAKEHOUSE_PARTITION_COLUMNS = ["project_id", "customer_id", "event_date"] as const

export type LakehouseFieldType = "string" | "int64" | "float64" | "boolean" | "json"

export interface LakehouseFieldDefinition {
  name: string
  type: LakehouseFieldType
  required: boolean
}

export interface LakehouseSourceSchemaDefinition {
  source: LakehouseSource
  streamName: string
  schemaFile: string
  sinkTable: string
  frontendTable: string
  tableAliases: readonly string[]
  partitionColumns: readonly string[]
  fields: readonly LakehouseFieldDefinition[]
}

type SourceSchemaMap = Record<LakehouseSource, LakehouseSourceSchemaDefinition>

export const lakehouseSourceSchemaRegistry = {
  usage: {
    source: "usage",
    streamName: "lakehouse_usage_stream",
    schemaFile: "usage.json",
    sinkTable: "usage",
    frontendTable: "usage",
    tableAliases: ["usage"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      { name: "id", type: "string", required: true },
      { name: "event_date", type: "string", required: true },
      { name: "request_id", type: "string", required: true },
      { name: "project_id", type: "string", required: true },
      { name: "customer_id", type: "string", required: true },
      { name: "timestamp", type: "int64", required: true },
      { name: "allowed", type: "boolean", required: true },
      { name: "idempotence_key", type: "string", required: true },
      { name: "feature_slug", type: "string", required: true },
      { name: "usage", type: "float64", required: true },
      { name: "entitlement_id", type: "string", required: true },
      { name: "deleted", type: "int64", required: false },
      { name: "meta_id", type: "string", required: false },
      { name: "country", type: "string", required: false },
      { name: "region", type: "string", required: false },
      { name: "action", type: "string", required: false },
      { name: "key_id", type: "string", required: false },
      { name: "unit_of_measure", type: "string", required: false },
      { name: "cost", type: "float64", required: false },
      { name: "rate_amount", type: "float64", required: false },
      { name: "rate_currency", type: "string", required: false },
      { name: "schema_version", type: "int64", required: false },
    ],
  },
  verification: {
    source: "verification",
    streamName: "lakehouse_verifications_stream",
    schemaFile: "verifications.json",
    sinkTable: "verification",
    frontendTable: "verifications",
    tableAliases: ["verification", "verifications"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      { name: "id", type: "string", required: true },
      { name: "event_date", type: "string", required: true },
      { name: "project_id", type: "string", required: true },
      { name: "denied_reason", type: "string", required: false },
      { name: "allowed", type: "int64", required: true },
      { name: "timestamp", type: "int64", required: true },
      { name: "latency", type: "float64", required: false },
      { name: "feature_slug", type: "string", required: true },
      { name: "customer_id", type: "string", required: true },
      { name: "request_id", type: "string", required: true },
      { name: "country", type: "string", required: false },
      { name: "region", type: "string", required: false },
      { name: "meta_id", type: "string", required: false },
      { name: "action", type: "string", required: false },
      { name: "key_id", type: "string", required: false },
      { name: "usage", type: "float64", required: false },
      { name: "remaining", type: "int64", required: false },
      { name: "entitlement_id", type: "string", required: false },
      { name: "schema_version", type: "int64", required: false },
    ],
  },
  metadata: {
    source: "metadata",
    streamName: "lakehouse_metadata_stream",
    schemaFile: "metadata.json",
    sinkTable: "metadata",
    frontendTable: "metadata",
    tableAliases: ["metadata"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      { name: "id", type: "string", required: true },
      { name: "event_date", type: "string", required: true },
      { name: "project_id", type: "string", required: true },
      { name: "customer_id", type: "string", required: true },
      { name: "payload", type: "json", required: false },
      { name: "timestamp", type: "int64", required: true },
      { name: "schema_version", type: "int64", required: false },
    ],
  },
  entitlement_snapshot: {
    source: "entitlement_snapshot",
    streamName: "lakehouse_entitlements_stream",
    schemaFile: "entitlements.json",
    sinkTable: "entitlement_snapshot",
    frontendTable: "entitlement_snapshots",
    tableAliases: ["entitlement_snapshot", "entitlement_snapshots"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      { name: "id", type: "string", required: true },
      { name: "event_date", type: "string", required: true },
      { name: "project_id", type: "string", required: true },
      { name: "customer_id", type: "string", required: true },
      { name: "timestamp", type: "int64", required: true },
      { name: "feature_slug", type: "string", required: true },
      { name: "feature_type", type: "string", required: true },
      { name: "unit_of_measure", type: "string", required: true },
      { name: "reset_config", type: "json", required: false },
      { name: "aggregation_method", type: "string", required: true },
      { name: "merging_policy", type: "string", required: true },
      { name: "limit", type: "int64", required: false },
      { name: "effective_at", type: "int64", required: true },
      { name: "expires_at", type: "int64", required: false },
      { name: "version", type: "string", required: true },
      { name: "grants", type: "json", required: true },
      { name: "metadata", type: "json", required: false },
      { name: "schema_version", type: "int64", required: false },
    ],
  },
} as const satisfies SourceSchemaMap

const tableAliasToSource = new Map<string, LakehouseSource>()
for (const source of Object.keys(lakehouseSourceSchemaRegistry) as LakehouseSource[]) {
  const entry = lakehouseSourceSchemaRegistry[source]
  for (const alias of entry.tableAliases) {
    tableAliasToSource.set(alias, source)
  }
}

export function getLakehouseSourceRegistry(): Readonly<SourceSchemaMap> {
  return lakehouseSourceSchemaRegistry
}

export function getLakehouseSourceSchema(source: LakehouseSource): LakehouseSourceSchemaDefinition {
  return lakehouseSourceSchemaRegistry[source]
}

export function listLakehouseSourceSchemas(): LakehouseSourceSchemaDefinition[] {
  return Object.values(lakehouseSourceSchemaRegistry)
}

export function getLakehouseFieldNames(source: LakehouseSource): string[] {
  return getLakehouseSourceSchema(source).fields.map((field) => field.name)
}

export function getLakehouseFieldDefinition(
  source: LakehouseSource,
  fieldName: string
): LakehouseFieldDefinition | undefined {
  return getLakehouseSourceSchema(source).fields.find((field) => field.name === fieldName)
}

export function resolveLakehouseSourceFromTable(tableName: string): LakehouseSource | undefined {
  return tableAliasToSource.get(tableName)
}

export function isLakehouseField(source: LakehouseSource, fieldName: string): boolean {
  return !!getLakehouseFieldDefinition(source, fieldName)
}

export function toCloudflarePipelineSchema(source: LakehouseSource): {
  fields: LakehouseFieldDefinition[]
} {
  return {
    fields: getLakehouseSourceSchema(source).fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
    })),
  }
}

export interface CloudflareLakehousePipelineDefinition {
  source: LakehouseSource
  stream: string
  sink: string
  sinkTable: string
  pipeline: string
  schemaFile: string
}

export function buildCloudflareLakehousePipelineDefinitions(
  prefix = "lakehouse"
): CloudflareLakehousePipelineDefinition[] {
  return listLakehouseSourceSchemas().map((entry) => {
    const suffixBySource: Record<LakehouseSource, string> = {
      usage: "usage",
      verification: "verifications",
      metadata: "metadata",
      entitlement_snapshot: "entitlements",
    }
    const suffix = suffixBySource[entry.source]

    return {
      source: entry.source,
      stream: entry.streamName,
      sink: `${prefix}_${suffix}_sink`,
      sinkTable: entry.sinkTable,
      pipeline: `${prefix}_${suffix}_pipeline`,
      schemaFile: entry.schemaFile,
    }
  })
}

export type LakehouseJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: LakehouseJsonValue }
  | LakehouseJsonValue[]

type LakehouseFieldValueByType<T extends LakehouseFieldType> = T extends "string"
  ? string
  : T extends "int64" | "float64"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "json"
        ? unknown
        : never

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type UnionToIntersection<T> = (T extends unknown ? (input: T) => void : never) extends (
  input: infer I
) => void
  ? I
  : never

type LakehouseFieldToProperty<T> = T extends {
  name: infer Name extends string
  type: infer FieldType extends LakehouseFieldType
  required: infer Required extends boolean
}
  ? Required extends true
    ? { [K in Name]: LakehouseFieldValueByType<FieldType> }
    : { [K in Name]?: LakehouseFieldValueByType<FieldType> }
  : never

type LakehouseEventFromFields<T extends readonly unknown[]> = Simplify<
  UnionToIntersection<LakehouseFieldToProperty<T[number]>>
>

type UsageEventFromRegistry = LakehouseEventFromFields<
  (typeof lakehouseSourceSchemaRegistry)["usage"]["fields"]
>
type VerificationEventFromRegistry = LakehouseEventFromFields<
  (typeof lakehouseSourceSchemaRegistry)["verification"]["fields"]
>
type MetadataEventFromRegistry = LakehouseEventFromFields<
  (typeof lakehouseSourceSchemaRegistry)["metadata"]["fields"]
>
type EntitlementSnapshotEventFromRegistry = LakehouseEventFromFields<
  (typeof lakehouseSourceSchemaRegistry)["entitlement_snapshot"]["fields"]
>

export type LakehouseEventBySource = {
  usage: UsageEventFromRegistry
  verification: VerificationEventFromRegistry
  metadata: MetadataEventFromRegistry
  entitlement_snapshot: EntitlementSnapshotEventFromRegistry
}

export type LakehouseEventForSource<S extends LakehouseSource> = LakehouseEventBySource[S]
