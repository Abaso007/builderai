import { z } from "zod"

export const lakehouseSourceSchema = z.enum([
  "usage",
  "verification",
  "metadata",
  "entitlement_snapshot",
])

export type LakehouseSource = z.infer<typeof lakehouseSourceSchema>

export const lakehouseIntervalSchema = z.enum(["24h", "7d", "30d", "90d"])

export const lakehouseManifestRequestSchema = z.object({
  project_id: z.string().optional(),
  customer_id: z.string().optional(),
  range: lakehouseIntervalSchema,
})

const fileDescriptorBaseSchema = z.object({
  key: z.string(),
  minTs: z.string(),
  maxTs: z.string(),
  count: z.number(),
  bytes: z.number(),
})

export const rawFileDescriptorSchema = fileDescriptorBaseSchema
export const compactFileDescriptorSchema = fileDescriptorBaseSchema

export const dayManifestSchema = z.object({
  day: z.string(),
  updatedAt: z.string(),
  raw: z.array(rawFileDescriptorSchema),
  compact: compactFileDescriptorSchema.nullable(),
})

export const fileDescriptorSchema = z.object({
  url: z.string(),
  key: z.string(),
  day: z.string(),
  type: z.enum(["raw", "compact", "metadata"]),
  source: lakehouseSourceSchema,
  count: z.number(),
  bytes: z.number(),
  etag: z.string().optional(),
  immutable: z.boolean().default(false),
})

export const manifestResponseSchema = z.object({
  range: z.string(),
  days: z.array(dayManifestSchema),
  files: z.array(fileDescriptorSchema),
})

export type RawFileDescriptor = z.infer<typeof rawFileDescriptorSchema>
export type CompactFileDescriptor = z.infer<typeof compactFileDescriptorSchema>
export type DayManifest = z.infer<typeof dayManifestSchema>
export type FileDescriptor = z.infer<typeof fileDescriptorSchema>
export type ManifestResponse = z.infer<typeof manifestResponseSchema>
