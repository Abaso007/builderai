import { createRoute } from "@hono/zod-openapi"
import { analyticsIntervalSchema, prepareInterval } from "@unprice/analytics"
import { startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import {
  type LakehouseSource,
  getDateRangeUTC,
  getLakehouseRawPrefix,
  signLakehouseKey,
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

/** Source of the file: which table to load into (usage_events, verification_events, metadata). */
export const fileSourceSchema = z.enum(["usage", "verification", "metadata"])

export const fileDescriptorSchema = z.object({
  url: z.string(),
  key: z.string(),
  day: z.string(),
  type: z.enum(["raw", "compact", "metadata"]),
  /** Which lakehouse table to load this file into. Enables JOINs (e.g. usage_events + metadata). */
  source: fileSourceSchema,
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
        project_id: z.string().optional().openapi({
          description: "The project ID (optional, only available for main projects)",
          example: "project_1H7KQFLr7RepUyQBKdnvY",
        }),
        customer_id: z.string().optional().openapi({
          description: "Filter to a single customer (optional)",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
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
    const { range, project_id: projectId, customer_id: customerId } = c.req.valid("json")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getLakehouseManifest")

    prepareInterval(range) // validates range

    // main workspace can see all usage
    const isMain = key.project.workspace.isMain
    const projectID = isMain ? (projectId ?? key.projectId) : key.projectId

    if (!isMain && projectId && projectID !== projectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "You are not allowed to access this app analytics.",
      })
    }

    if (!c.env.LAKEHOUSE) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Lakehouse storage not configured",
      })
    }

    const listAll = async (prefix: string) => {
      const objects: { key: string; size?: number }[] = []
      let cursor: string | undefined = undefined
      do {
        const res = await c.env.LAKEHOUSE!.list({ prefix, cursor })
        objects.push(...res.objects)
        cursor = res.truncated ? res.cursor : undefined
      } while (cursor)
      return objects
    }

    const dates = getDateRangeUTC(range)
    const rawByDay = new Map<string, RawFileDescriptor[]>()
    const allFiles: Array<{ day: string; source: LakehouseSource; key: string; bytes: number }> = []

    const sources: LakehouseSource[] = ["usage", "verification", "metadata"]

    for (const day of dates) {
      rawByDay.set(day, [])
      for (const source of sources) {
        const prefix = getLakehouseRawPrefix(projectID, source, day, customerId)
        const objects = await listAll(prefix)
        for (const obj of objects) {
          const rawDesc: RawFileDescriptor = {
            key: obj.key,
            minTs: "0",
            maxTs: "0",
            count: 0,
            bytes: obj.size ?? 0,
          }

          rawByDay.get(day)!.push(rawDesc)

          allFiles.push({ day, source, key: obj.key, bytes: obj.size ?? 0 })
        }
      }
    }

    // Derive from request so it works in Workers (preview/prod/localhost). Config uses process.env
    // which is not set in Cloudflare Workers runtime — only c.env has VERCEL_ENV.
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "api.unprice.dev"
    const protocol =
      c.req.header("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https")
    const API_URL = `${protocol}://${host}/v1/lakehouse/file`
    const exp = Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour

    const files: FileDescriptor[] = []
    for (const { day, source, key, bytes } of allFiles) {
      const sig = await signLakehouseKey(c.env.AUTH_SECRET, key, exp)
      files.push({
        url: `${API_URL}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`,
        key,
        day,
        type: source === "metadata" ? "metadata" : "raw",
        source,
        count: 0,
        bytes,
      })
    }

    const days: DayManifest[] = dates.map((day) => ({
      day,
      updatedAt: new Date().toISOString(),
      raw: rawByDay.get(day) ?? [],
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
