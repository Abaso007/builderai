import type { LakehouseSource } from "./source"

export const LAKEHOUSE_PARTITION_COLUMNS = ["project_id", "customer_id", "event_date"] as const

export type LakehouseFieldType =
  | "string"
  | "int64"
  | "int32"
  | "float64"
  | "float32"
  | "f64"
  | "f32"
  | "boolean"
  | "bool"
  | "json"
  | "datetime"
  | "timestamp"
  | "bytes"
  | "list"
  | "struct"
export type LakehouseFieldDefaultValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Uint8Array
  | Record<string, unknown>
  | unknown[]

export interface LakehouseFieldDefinition {
  name: string
  type: LakehouseFieldType
  required: boolean
  addedInVersion: number
  defaultValue: LakehouseFieldDefaultValue
  description: string
}

export interface LakehouseSourceSchemaDefinition {
  source: LakehouseSource
  firstVersion: number
  currentVersion: number
  streamName: string
  schemaFile: string
  sinkTable: string
  frontendTable: string
  tableAliases: readonly string[]
  partitionColumns: readonly string[]
  fields: readonly LakehouseFieldDefinition[]
}

type SourceSchemaMap = Record<LakehouseSource, LakehouseSourceSchemaDefinition>

export type CloudflarePipelineFieldType =
  | "list"
  | "struct"
  | "bytes"
  | "json"
  | "timestamp"
  | "f64"
  | "f32"
  | "int64"
  | "int32"
  | "bool"
  | "string"

export const lakehouseSourceSchemaRegistry = {
  usage: {
    source: "usage",
    firstVersion: 1,
    currentVersion: 1,
    streamName: "lakehouse_usage_stream",
    schemaFile: "usage.json",
    sinkTable: "usage",
    frontendTable: "usage",
    tableAliases: ["usage"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      {
        name: "id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Unique usage event identifier.",
      },
      {
        name: "event_date",
        type: "datetime",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "UTC date partition key formatted as YYYY-MM-DD.",
      },
      {
        name: "request_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Request identifier tied to the usage event.",
      },
      {
        name: "project_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Project identifier.",
      },
      {
        name: "customer_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Customer identifier.",
      },
      {
        name: "timestamp",
        type: "int64",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Event timestamp (epoch milliseconds).",
      },
      {
        name: "idempotence_key",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Idempotency key for de-duplication.",
      },
      {
        name: "entitlement_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Serialized entitlement snapshot identifier payload.",
      },
      {
        name: "feature_slug",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Feature slug tied to usage.",
      },
      {
        name: "schema_version",
        type: "int32",
        required: true,
        addedInVersion: 1,
        defaultValue: 1,
        description: "Schema version for this event payload.",
      },
      {
        name: "usage",
        type: "float64",
        required: false,
        addedInVersion: 1,
        defaultValue: 0,
        description: "Usage amount consumed by the event.",
      },
      {
        name: "allowed",
        type: "boolean",
        required: false,
        addedInVersion: 1,
        defaultValue: true,
        description: "Whether the request was allowed.",
      },
      {
        name: "deleted",
        type: "int64",
        required: false,
        addedInVersion: 1,
        defaultValue: 0,
        description: "Soft-deletion marker (0 = active, 1 = deleted).",
      },
      {
        name: "meta_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Stable hash ID for metadata payload.",
      },
      {
        name: "country",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: "UNK",
        description: "ISO country code or UNK.",
      },
      {
        name: "region",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: "UNK",
        description: "Region code or UNK.",
      },
      {
        name: "action",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Action label provided by upstream metadata.",
      },
      {
        name: "key_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Key identifier associated with the request.",
      },
      {
        name: "unit_of_measure",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: "unit",
        description: "Unit associated with usage value.",
      },
      {
        name: "cost",
        type: "float64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Computed cost for the usage event.",
      },
      {
        name: "rate_amount",
        type: "float64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Rate amount used to compute cost.",
      },
      {
        name: "rate_currency",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Currency for rate/cost values.",
      },
    ],
  },
  verification: {
    source: "verification",
    firstVersion: 1,
    currentVersion: 1,
    streamName: "lakehouse_verifications_stream",
    schemaFile: "verifications.json",
    sinkTable: "verification",
    frontendTable: "verifications",
    tableAliases: ["verification", "verifications"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      {
        name: "id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Unique verification event identifier.",
      },
      {
        name: "event_date",
        type: "datetime",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "UTC date partition key formatted as YYYY-MM-DD.",
      },
      {
        name: "project_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Project identifier.",
      },
      {
        name: "entitlement_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Serialized entitlement snapshot identifier payload.",
      },
      {
        name: "feature_slug",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Feature slug being verified.",
      },
      {
        name: "customer_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Customer identifier.",
      },
      {
        name: "request_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Request identifier tied to verification.",
      },
      {
        name: "timestamp",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Event timestamp (epoch milliseconds).",
      },
      {
        name: "schema_version",
        type: "int32",
        required: true,
        addedInVersion: 1,
        defaultValue: 1,
        description: "Schema version for this event payload.",
      },
      {
        name: "allowed",
        type: "boolean",
        required: false,
        addedInVersion: 1,
        defaultValue: false,
        description: "Verification outcome.",
      },
      {
        name: "denied_reason",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Reason for denied verification.",
      },
      {
        name: "latency",
        type: "float64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Verification latency in milliseconds.",
      },
      {
        name: "country",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: "UNK",
        description: "ISO country code or UNK.",
      },
      {
        name: "region",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: "UNK",
        description: "Region code or UNK.",
      },
      {
        name: "meta_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Stable hash ID for metadata payload.",
      },
      {
        name: "action",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Action label provided by upstream metadata.",
      },
      {
        name: "key_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Key identifier associated with the request.",
      },
      {
        name: "usage",
        type: "float64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Usage amount consumed during verification.",
      },
      {
        name: "remaining",
        type: "int64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Remaining balance after verification.",
      },
      {
        name: "unit_of_measure",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: "unit",
        description: "Unit associated with usage value.",
      },
      {
        name: "cost",
        type: "float64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Computed cost for the verification event.",
      },
      {
        name: "rate_amount",
        type: "float64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Rate amount used to compute cost.",
      },
      {
        name: "rate_currency",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Currency for rate/cost values.",
      },
    ],
  },
  metadata: {
    source: "metadata",
    firstVersion: 1,
    currentVersion: 1,
    streamName: "lakehouse_metadata_stream",
    schemaFile: "metadata.json",
    sinkTable: "metadata",
    frontendTable: "metadata",
    tableAliases: ["metadata"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      {
        name: "id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Metadata payload stable hash identifier.",
      },
      {
        name: "event_date",
        type: "datetime",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "UTC date partition key formatted as YYYY-MM-DD.",
      },
      {
        name: "project_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Project identifier.",
      },
      {
        name: "customer_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Customer identifier.",
      },
      {
        name: "schema_version",
        type: "int32",
        required: true,
        addedInVersion: 1,
        defaultValue: 1,
        description: "Schema version for this event payload.",
      },
      {
        name: "timestamp",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Event timestamp (epoch milliseconds).",
      },
      {
        name: "payload",
        type: "json",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Metadata payload with user-defined tags.",
      },
    ],
  },
  entitlement_snapshot: {
    source: "entitlement_snapshot",
    firstVersion: 1,
    currentVersion: 1,
    streamName: "lakehouse_entitlements_stream",
    schemaFile: "entitlements.json",
    sinkTable: "entitlement_snapshot",
    frontendTable: "entitlement_snapshots",
    tableAliases: ["entitlement_snapshot", "entitlement_snapshots"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      {
        name: "id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Immutable entitlement snapshot identifier.",
      },
      {
        name: "event_date",
        type: "datetime",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "UTC date partition key formatted as YYYY-MM-DD.",
      },
      {
        name: "project_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Project identifier.",
      },
      {
        name: "customer_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Customer identifier.",
      },
      {
        name: "schema_version",
        type: "int32",
        required: true,
        addedInVersion: 1,
        defaultValue: 1,
        description: "Schema version for this event payload.",
      },
      {
        name: "timestamp",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Event timestamp (epoch milliseconds).",
      },
      {
        name: "feature_slug",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Feature slug represented by the snapshot.",
      },
      {
        name: "feature_type",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Feature type (for example metered or boolean).",
      },
      {
        name: "unit_of_measure",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: "unit",
        description: "Unit for entitlement usage accounting.",
      },
      {
        name: "reset_config",
        type: "json",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Reset schedule configuration.",
      },
      {
        name: "aggregation_method",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Aggregation strategy used by entitlement.",
      },
      {
        name: "merging_policy",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Merging policy for grants/entitlements.",
      },
      {
        name: "limit",
        type: "int64",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Limit value when applicable.",
      },
      {
        name: "effective_at",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Start timestamp for this snapshot.",
      },
      {
        name: "expires_at",
        type: "timestamp",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Expiry timestamp for this snapshot.",
      },
      {
        name: "version",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Entitlement domain version identifier.",
      },
      {
        name: "grants",
        type: "json",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Grant set serialized as JSON.",
      },
      {
        name: "metadata",
        type: "json",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Optional entitlement metadata JSON.",
      },
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

function validateSchemaVersion(
  source: LakehouseSource,
  version: number,
  schema: LakehouseSourceSchemaDefinition
) {
  if (!Number.isInteger(version)) {
    throw new Error(`Schema version for source '${source}' must be an integer`)
  }
  if (version < schema.firstVersion || version > schema.currentVersion) {
    throw new Error(
      `Schema version ${version} for source '${source}' is out of range (${schema.firstVersion}..${schema.currentVersion})`
    )
  }
}

export function getLakehouseSourceCurrentVersion(source: LakehouseSource): number {
  return getLakehouseSourceSchema(source).currentVersion
}

export function getLakehouseSourceFieldsForVersion(
  source: LakehouseSource,
  schemaVersion: number
): LakehouseFieldDefinition[] {
  const schema = getLakehouseSourceSchema(source)
  validateSchemaVersion(source, schemaVersion, schema)
  return schema.fields.filter((field) => field.addedInVersion <= schemaVersion)
}

export function listLakehouseSourceSchemas(): LakehouseSourceSchemaDefinition[] {
  return Object.values(lakehouseSourceSchemaRegistry)
}

export function getLakehouseFieldNames(source: LakehouseSource, schemaVersion?: number): string[] {
  if (schemaVersion === undefined) {
    return getLakehouseSourceSchema(source).fields.map((field) => field.name)
  }

  return getLakehouseSourceFieldsForVersion(source, schemaVersion).map((field) => field.name)
}

export function getLakehouseFieldDefinition(
  source: LakehouseSource,
  fieldName: string,
  schemaVersion?: number
): LakehouseFieldDefinition | undefined {
  const fields =
    schemaVersion === undefined
      ? getLakehouseSourceSchema(source).fields
      : getLakehouseSourceFieldsForVersion(source, schemaVersion)

  return fields.find((field) => field.name === fieldName)
}

export function resolveLakehouseSourceFromTable(tableName: string): LakehouseSource | undefined {
  return tableAliasToSource.get(tableName)
}

export function isLakehouseField(
  source: LakehouseSource,
  fieldName: string,
  schemaVersion?: number
): boolean {
  return !!getLakehouseFieldDefinition(source, fieldName, schemaVersion)
}

export function toCloudflarePipelineSchema(source: LakehouseSource): {
  fields: Array<{
    name: string
    type: CloudflarePipelineFieldType
    required: boolean
  }>
} {
  const toCloudflareType = (fieldType: LakehouseFieldType): CloudflarePipelineFieldType => {
    switch (fieldType) {
      case "string":
      case "list":
      case "struct":
      case "bytes":
      case "json":
      case "int64":
      case "int32":
      case "f64":
      case "f32":
      case "timestamp":
        return fieldType
      case "float64":
        return "f64"
      case "float32":
        return "f32"
      case "boolean":
      case "bool":
        // Cloudflare stream schema type is `bool` (not `boolean`).
        return "bool"
      case "datetime":
        // Cloudflare does not expose `datetime`; normalize to `timestamp`.
        return "timestamp"
      default: {
        const _never: never = fieldType
        throw new Error(`Unsupported lakehouse field type for Cloudflare schema: ${String(_never)}`)
      }
    }
  }

  return {
    fields: getLakehouseSourceSchema(source).fields.map((field) => ({
      name: field.name,
      type: toCloudflareType(field.type),
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
  : T extends "int64" | "int32" | "float64" | "float32" | "f64" | "f32"
    ? number
    : T extends "boolean" | "bool"
      ? boolean
      : T extends "json"
        ? LakehouseJsonValue
        : T extends "timestamp"
          ? string | number | Date
          : T extends "datetime"
            ? string | Date
            : T extends "bytes"
              ? string | Uint8Array
              : T extends "list"
                ? unknown[]
                : T extends "struct"
                  ? Record<string, unknown>
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

for (const source of Object.keys(lakehouseSourceSchemaRegistry) as LakehouseSource[]) {
  const schema = lakehouseSourceSchemaRegistry[source]

  if (schema.firstVersion > schema.currentVersion) {
    throw new Error(
      `Invalid version range for source '${source}': firstVersion=${schema.firstVersion}, currentVersion=${schema.currentVersion}`
    )
  }

  const fieldNames = new Set<string>()
  for (const field of schema.fields) {
    if (fieldNames.has(field.name)) {
      throw new Error(`Duplicate field '${field.name}' in source '${source}'`)
    }
    fieldNames.add(field.name)

    if (
      !Number.isInteger(field.addedInVersion) ||
      field.addedInVersion < schema.firstVersion ||
      field.addedInVersion > schema.currentVersion
    ) {
      throw new Error(
        `Field '${field.name}' on source '${source}' has invalid addedInVersion=${field.addedInVersion}`
      )
    }
  }

  for (const partitionField of schema.partitionColumns) {
    if (!fieldNames.has(partitionField)) {
      throw new Error(
        `Partition field '${partitionField}' is missing from source '${source}' schema fields`
      )
    }
  }

  const schemaVersionField = schema.fields.find((field) => field.name === "schema_version")
  if (!schemaVersionField) {
    throw new Error(`Source '${source}' must include a schema_version field`)
  }
  if (
    (schemaVersionField.type !== "int32" && schemaVersionField.type !== "int64") ||
    !schemaVersionField.required
  ) {
    throw new Error(`Source '${source}' schema_version field must be required int32 or int64`)
  }
}
