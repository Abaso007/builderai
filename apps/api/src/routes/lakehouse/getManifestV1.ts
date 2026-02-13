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
  getLakehouseCompactedPrefix,
  getLakehouseCompactionMarkerKey,
  getLakehouseLegacyCompactedPrefix,
  getLakehouseLegacyCompactionMarkerKey,
  getLakehouseLegacyRawPrefix,
  getLakehouseRawPrefix,
  signLakehouseKey,
} from "~/util/lakehouse"
import {
  type LakehouseDaySourceIndex,
  addRawEntry,
  readLakehouseIndex,
  updateLakehouseIndex,
} from "~/util/lakehouse-index"

interface RawCompactionMarker {
  version: 1
  projectId: string
  source: LakehouseSource
  day: string
  compactedKey: string
  sourceKeys: string[]
  compactedAt: string
}

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

const tags = ["lakehouse"]
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 // 24 hours

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
      const objects: { key: string; size?: number; etag?: string; uploaded?: Date }[] = []
      let cursor: string | undefined = undefined
      do {
        const res = await c.env.LAKEHOUSE!.list({ prefix, cursor })
        objects.push(...res.objects)
        cursor = res.truncated ? res.cursor : undefined
      } while (cursor)
      return objects
    }

    const loadCompactionMarker = async (
      projectId: string,
      source: LakehouseSource,
      day: string
    ): Promise<RawCompactionMarker | null> => {
      const markerKeys = [
        getLakehouseCompactionMarkerKey(projectId, source, day),
        getLakehouseLegacyCompactionMarkerKey(projectId, source, day),
      ]

      for (const markerKey of markerKeys) {
        const markerObj = await c.env.LAKEHOUSE!.get(markerKey)
        if (!markerObj) {
          continue
        }

        try {
          const parsed = JSON.parse(await markerObj.text()) as RawCompactionMarker
          if (Array.isArray(parsed.sourceKeys)) {
            return parsed
          }
        } catch {}
      }

      return null
    }

    const matchesCustomerFilter = (rawKey: string): boolean => {
      if (!customerId) {
        return true
      }
      return rawKey.includes(`/customer=${customerId}/`)
    }

    const dates = getDateRangeUTC(range)
    const rawByDay = new Map<string, RawFileDescriptor[]>()
    const compactByDay = new Map<string, CompactFileDescriptor | null>()
    const dayLatestUploadedAtMs = new Map<string, number>()
    const allFiles: Array<{
      day: string
      source: LakehouseSource
      key: string
      bytes: number
      etag?: string
      type: "raw" | "compact" | "metadata"
      immutable: boolean
    }> = []

    const sources: LakehouseSource[] = ["usage", "verification", "metadata"]

    for (const day of dates) {
      rawByDay.set(day, [])
      compactByDay.set(day, null)
      dayLatestUploadedAtMs.set(day, 0)
      for (const source of sources) {
        const indexed = await readLakehouseIndex({
          bucket: c.env.LAKEHOUSE!,
          projectId: projectID,
          source,
          day,
        })

        if (indexed) {
          const marker = indexed.compact ? await loadCompactionMarker(projectID, source, day) : null
          const markerRawKeySet =
            marker && indexed.compact && marker.compactedKey === indexed.compact.key
              ? new Set(marker.sourceKeys)
              : null

          if (indexed.compact) {
            const compactDesc: CompactFileDescriptor = {
              key: indexed.compact.key,
              minTs: "0",
              maxTs: "0",
              count: 0,
              bytes: indexed.compact.bytes,
            }
            compactByDay.set(day, compactDesc)
            allFiles.push({
              day,
              source,
              key: indexed.compact.key,
              bytes: indexed.compact.bytes,
              etag: indexed.compact.etag,
              type: "compact",
              immutable: true,
            })
            const compactUploadedAtMs = Date.parse(indexed.compact.uploadedAt)
            const currentLatest = dayLatestUploadedAtMs.get(day) ?? 0
            dayLatestUploadedAtMs.set(
              day,
              Math.max(currentLatest, Number.isNaN(compactUploadedAtMs) ? 0 : compactUploadedAtMs)
            )
          }

          for (const raw of indexed.raw) {
            if (!matchesCustomerFilter(raw.key)) {
              continue
            }

            if (markerRawKeySet?.has(raw.key)) {
              continue
            }
            rawByDay.get(day)!.push({
              key: raw.key,
              minTs: "0",
              maxTs: "0",
              count: 0,
              bytes: raw.bytes,
            })

            allFiles.push({
              day,
              source,
              key: raw.key,
              bytes: raw.bytes,
              etag: raw.etag,
              type: source === "metadata" ? "metadata" : "raw",
              immutable: true,
            })
            const rawUploadedAtMs = Date.parse(raw.uploadedAt)
            const currentLatest = dayLatestUploadedAtMs.get(day) ?? 0
            dayLatestUploadedAtMs.set(
              day,
              Math.max(currentLatest, Number.isNaN(rawUploadedAtMs) ? 0 : rawUploadedAtMs)
            )
          }

          continue
        }

        const compactedPrefix = getLakehouseCompactedPrefix(projectID, source, day)
        const legacyCompactedPrefix = getLakehouseLegacyCompactedPrefix(projectID, source, day)
        const [compactedObjects, legacyCompactedObjects] = await Promise.all([
          listAll(compactedPrefix),
          listAll(legacyCompactedPrefix),
        ])
        const allCompactedObjects = [...compactedObjects, ...legacyCompactedObjects]
        const compactedKeySet = new Set(allCompactedObjects.map((obj) => obj.key))
        const marker = await loadCompactionMarker(projectID, source, day)
        const markerRawKeySet =
          marker && compactedKeySet.has(marker.compactedKey) ? new Set(marker.sourceKeys) : null

        const latestCompacted =
          allCompactedObjects.length > 0
            ? allCompactedObjects.slice().sort((a, b) => {
                const aUploaded = a.uploaded ? new Date(a.uploaded).getTime() : 0
                const bUploaded = b.uploaded ? new Date(b.uploaded).getTime() : 0
                if (aUploaded !== bUploaded) return bUploaded - aUploaded
                return b.key.localeCompare(a.key)
              })[0]
            : undefined

        if (latestCompacted) {
          compactByDay.set(day, {
            key: latestCompacted.key,
            minTs: "0",
            maxTs: "0",
            count: 0,
            bytes: latestCompacted.size ?? 0,
          })
          allFiles.push({
            day,
            source,
            key: latestCompacted.key,
            bytes: latestCompacted.size ?? 0,
            etag: latestCompacted.etag,
            type: "compact",
            immutable: true,
          })
          const uploadedAtMs = latestCompacted.uploaded
            ? new Date(latestCompacted.uploaded).getTime()
            : 0
          const currentLatest = dayLatestUploadedAtMs.get(day) ?? 0
          dayLatestUploadedAtMs.set(day, Math.max(currentLatest, uploadedAtMs))
        }

        const prefix = getLakehouseRawPrefix(projectID, source, day, customerId)
        const legacyPrefix = getLakehouseLegacyRawPrefix(projectID, source, day, customerId)
        const [objects, legacyObjects] = await Promise.all([listAll(prefix), listAll(legacyPrefix)])
        const allRawObjects = [...objects, ...legacyObjects]
        const discoveredRaw = [] as Array<{
          key: string
          bytes: number
          etag?: string
          uploadedAt: string
        }>

        for (const obj of allRawObjects) {
          if (markerRawKeySet?.has(obj.key)) {
            continue
          }

          rawByDay.get(day)!.push({
            key: obj.key,
            minTs: "0",
            maxTs: "0",
            count: 0,
            bytes: obj.size ?? 0,
          })

          allFiles.push({
            day,
            source,
            key: obj.key,
            bytes: obj.size ?? 0,
            etag: obj.etag,
            type: source === "metadata" ? "metadata" : "raw",
            immutable: true,
          })
          const uploadedAt = obj.uploaded
            ? new Date(obj.uploaded).toISOString()
            : new Date(0).toISOString()
          discoveredRaw.push({
            key: obj.key,
            bytes: obj.size ?? 0,
            etag: obj.etag,
            uploadedAt,
          })
          const uploadedAtMs = obj.uploaded ? new Date(obj.uploaded).getTime() : 0
          const currentLatest = dayLatestUploadedAtMs.get(day) ?? 0
          dayLatestUploadedAtMs.set(day, Math.max(currentLatest, uploadedAtMs))
        }

        await updateLakehouseIndex({
          bucket: c.env.LAKEHOUSE!,
          projectId: projectID,
          source,
          day,
          mutate: (current: LakehouseDaySourceIndex) => {
            let next = { ...current, compact: current.compact, raw: current.raw.slice() }
            for (const raw of discoveredRaw) {
              next = addRawEntry(next, raw)
            }
            if (latestCompacted) {
              next.compact = {
                key: latestCompacted.key,
                bytes: latestCompacted.size ?? 0,
                etag: latestCompacted.etag,
                uploadedAt: latestCompacted.uploaded
                  ? new Date(latestCompacted.uploaded).toISOString()
                  : new Date().toISOString(),
              }
            }
            return next
          },
        })
      }
    }
    allFiles.sort((a, b) => a.key.localeCompare(b.key))

    // Derive from request so it works in Workers (preview/prod/localhost). Config uses process.env
    // which is not set in Cloudflare Workers runtime — only c.env has APP_ENV.
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "api.unprice.dev"
    const protocol =
      c.req.header("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https")
    const API_URL = `${protocol}://${host}/v1/lakehouse/file`
    const nowEpochSeconds = Math.floor(Date.now() / 1000)
    const exp = (Math.floor(nowEpochSeconds / SIGNED_URL_TTL_SECONDS) + 1) * SIGNED_URL_TTL_SECONDS

    const files: FileDescriptor[] = []
    for (const { day, source, key, bytes, etag, type, immutable } of allFiles) {
      const sig = await signLakehouseKey(c.env.AUTH_SECRET, key, exp)
      const versionQuery = etag ? `&v=${encodeURIComponent(etag)}` : ""
      files.push({
        url: `${API_URL}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}${versionQuery}`,
        key,
        day,
        type,
        source,
        count: 0,
        bytes,
        etag,
        immutable,
      })
    }

    const days: DayManifest[] = dates.map((day) => ({
      day,
      updatedAt:
        dayLatestUploadedAtMs.get(day) && (dayLatestUploadedAtMs.get(day) ?? 0) > 0
          ? new Date(dayLatestUploadedAtMs.get(day) ?? 0).toISOString()
          : `${day}T00:00:00.000Z`,
      raw: rawByDay.get(day) ?? [],
      compact: compactByDay.get(day) ?? null,
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
      HttpStatusCodes.OK,
      {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
      }
    )
  })
