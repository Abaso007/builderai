import { z } from "zod"
import {
  type LakehouseEventForSource,
  type LakehouseFieldDefinition,
  type LakehouseJsonValue,
  getLakehouseSourceSchema,
} from "./registry"
import type { LakehouseSource } from "./source"

export const lakehouseJsonValueSchema: z.ZodType<LakehouseJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(lakehouseJsonValueSchema),
    z.record(lakehouseJsonValueSchema),
  ])
)

function fieldToSchema(field: LakehouseFieldDefinition): z.ZodTypeAny {
  let schema: z.ZodTypeAny

  switch (field.type) {
    case "string":
      schema = z.string()
      break
    case "int64":
      schema = z.number().int()
      break
    case "float64":
      schema = z.number().finite()
      break
    case "boolean":
      schema = z.boolean()
      break
    case "json":
      schema = lakehouseJsonValueSchema
      break
    default: {
      const _never: never = field.type
      throw new Error(`Unsupported lakehouse field type: ${String(_never)}`)
    }
  }

  return field.required ? schema : schema.optional()
}

export function buildLakehouseEventZodSchema(
  source: LakehouseSource
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const definition = getLakehouseSourceSchema(source)
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const field of definition.fields) {
    shape[field.name] = fieldToSchema(field)
  }

  return z.object(shape)
}

export const LAKEHOUSE_EVENT_ZOD_SCHEMAS: {
  [S in LakehouseSource]: z.ZodType<LakehouseEventForSource<S>>
} = {
  usage: buildLakehouseEventZodSchema("usage") as unknown as z.ZodType<
    LakehouseEventForSource<"usage">
  >,
  verification: buildLakehouseEventZodSchema("verification") as unknown as z.ZodType<
    LakehouseEventForSource<"verification">
  >,
  metadata: buildLakehouseEventZodSchema("metadata") as unknown as z.ZodType<
    LakehouseEventForSource<"metadata">
  >,
  entitlement_snapshot: buildLakehouseEventZodSchema(
    "entitlement_snapshot"
  ) as unknown as z.ZodType<LakehouseEventForSource<"entitlement_snapshot">>,
}

export function getLakehouseSourceEventZodSchema<S extends LakehouseSource>(
  source: S
): z.ZodType<LakehouseEventForSource<S>> {
  return LAKEHOUSE_EVENT_ZOD_SCHEMAS[source]
}

export function parseLakehouseEvent<S extends LakehouseSource>(
  source: S,
  input: unknown
): LakehouseEventForSource<S> {
  return getLakehouseSourceEventZodSchema(source).parse(input)
}

export function safeParseLakehouseEvent<S extends LakehouseSource>(source: S, input: unknown) {
  return getLakehouseSourceEventZodSchema(source).safeParse(input)
}
