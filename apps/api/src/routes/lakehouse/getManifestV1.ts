import { createRoute } from "@hono/zod-openapi"
import { analyticsIntervalSchema, prepareInterval } from "@unprice/analytics"
import { API_DOMAIN } from "@unprice/config"
import { startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import {
  getDateRangeUTC,
  getMetadataManifestKey,
  getUsageManifestKey,
  getVerificationManifestKey,
} from "~/util/lakehouse"

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
  day: z.string(), // YYYY-MM-DD
  updatedAt: z.string(), // ISO 8601
  raw: z.array(rawFileDescriptorSchema),
  compact: compactFileDescriptorSchema.nullable(),
})

export const fileDescriptorSchema = z.object({
  url: z.string(),
  key: z.string(),
  day: z.string(),
  type: z.enum(["raw", "compact", "metadata"]),
  count: z.number(),
  bytes: z.number(),
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

const tags = ["lakehouse"]

export const route = createRoute({
  path: "/v1/lakehouse/manifest",
  operationId: "lakehouse.getManifest",
  summary: "get lakehouse manifest",
  description: "Get lakehouse manifest for a given range",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customer_id: z
          .string()
          .openapi({
            description:
              "The customer ID (optional; if not provided, all customers will be included)",
            example: "cus_1H7KQFLr7RepUyQBKdnvY",
          })
          .optional(),
        project_id: z.string().openapi({
          description: "The project ID (optional, only available for main projects)",
          example: "project_1H7KQFLr7RepUyQBKdnvY",
        }),
        range: analyticsIntervalSchema.openapi({
          description: "The range of the usage, last hour, day, week or month",
          example: "24h",
        }),
      }),
      "Body of the request for the get usage"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        manifest: manifestResponseSchema,
      }),
      "The result of the get lakehouse manifest"
    ),
    ...openApiErrorResponses,
  },
})

export type GetLakehouseManifestRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetLakehouseManifestResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>
export const registerGetLakehouseManifestV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customer } = c.get("services")
    const { customer_id: customerId, range, project_id: projectId } = c.req.valid("json")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getLakehouseManifest")

    prepareInterval(range) // validates range

    // main workspace can see all usage
    const isMain = key.project.workspace.isMain
    const projectID = isMain ? (projectId ? projectId : key.projectId) : key.projectId

    if (!isMain && projectID !== projectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to access this app analytics.",
      })
    }

    const dates = getDateRangeUTC(range)
    const dateSet = new Set(dates)

    const usageKeys: string[] = []
    const verificationKeys: string[] = []
    const metadataKeys: string[] = []

    if (!customerId) {
      const { val: customers, err } = await customer.getCustomersProject(projectID)

      if (err) {
        throw new UnpriceApiError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error getting customers project",
        })
      }

      customers.forEach((customer) => {
        usageKeys.push(getUsageManifestKey(projectID, customer.id))
        verificationKeys.push(getVerificationManifestKey(projectID, customer.id))
        metadataKeys.push(getMetadataManifestKey(projectID, customer.id))
      })
    } else {
      usageKeys.push(getUsageManifestKey(projectID, customerId))
      verificationKeys.push(getVerificationManifestKey(projectID, customerId))
      metadataKeys.push(getMetadataManifestKey(projectID, customerId))
    }

    const usagePromises = usageKeys.map((key) => c.env.LAKEHOUSE?.get(key))
    const verificationPromises = verificationKeys.map((key) => c.env.LAKEHOUSE?.get(key))
    const metadataPromises = metadataKeys.map((key) => c.env.LAKEHOUSE?.get(key))
    const [usageObjs, verificationObjs, metadataObjs] = await Promise.all([
      Promise.all(usagePromises),
      Promise.all(verificationPromises),
      Promise.all(metadataPromises),
    ])

    interface R2FileDescriptor {
      key: string
      day: string
      minTs: number
      maxTs: number
      count: number
      bytes: number
    }

    interface R2DataTypeManifest {
      projectId: string
      customerId: string
      updatedAt: string
      files: R2FileDescriptor[]
    }

    type FileWithType = { day: string; desc: R2FileDescriptor; type: "raw" | "metadata" }
    const allFiles: FileWithType[] = []

    for (const usageObj of usageObjs) {
      if (!usageObj) continue
      const usageManifest = await usageObj.json<R2DataTypeManifest>()
      for (const f of usageManifest.files ?? []) {
        if (dateSet.has(f.day)) allFiles.push({ day: f.day, desc: f, type: "raw" })
      }
    }

    for (const verificationObj of verificationObjs) {
      if (!verificationObj) continue
      const verificationManifest = await verificationObj.json<R2DataTypeManifest>()
      for (const f of verificationManifest.files ?? []) {
        if (dateSet.has(f.day)) allFiles.push({ day: f.day, desc: f, type: "raw" })
      }
    }

    for (const metadataObj of metadataObjs) {
      if (!metadataObj) continue
      const metadataManifest = await metadataObj.json<R2DataTypeManifest>()
      for (const f of metadataManifest.files ?? []) {
        if (dateSet.has(f.day)) allFiles.push({ day: f.day, desc: f, type: "metadata" })
      }
    }

    const API_URL = `${API_DOMAIN}v1/lakehouse/file`

    const files: FileDescriptor[] = allFiles.map(({ day, desc, type }) => ({
      url: `${API_URL}?key=${encodeURIComponent(desc.key)}`,
      key: desc.key,
      day,
      type,
      count: desc.count,
      bytes: desc.bytes,
    }))

    const byDay = new Map<string, RawFileDescriptor[]>()
    for (const d of dates) byDay.set(d, [])
    for (const { day, desc, type } of allFiles) {
      if (type !== "raw") continue
      const raw: RawFileDescriptor = {
        key: desc.key,
        minTs: String(desc.minTs),
        maxTs: String(desc.maxTs),
        count: desc.count,
        bytes: desc.bytes,
      }
      byDay.get(day)!.push(raw)
    }

    const days: DayManifest[] = dates.map((day) => ({
      day,
      updatedAt: new Date().toISOString(),
      raw: byDay.get(day) ?? [],
      compact: null,
    }))

    const response: ManifestResponse = {
      range,
      days,
      files,
    }

    return c.json(
      {
        manifest: response,
      },
      HttpStatusCodes.OK
    )
  })
