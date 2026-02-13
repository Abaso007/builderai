import { env } from "cloudflare:workers"
import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { type CompactionResult, handleCompactionForDay } from "~/scheduled/compaction"

const tags = ["lakehouse"]

const compactionResultSchema = z.object({
  success: z.boolean(),
  day: z.string(),
  projectsProcessed: z.number(),
  results: z.array(
    z.object({
      projectId: z.string(),
      source: z.enum(["usage", "verification", "metadata"]),
      compacted: z.boolean(),
      skipped: z.boolean(),
      files: z.number(),
      lines: z.number(),
      bytes: z.number(),
      invalidLines: z.number(),
    })
  ),
  error: z.string().optional(),
})

export const route = createRoute({
  path: "/v1/lakehouse/compact",
  operationId: "lakehouse.compact",
  summary: "compact lakehouse files",
  description:
    "Manually trigger compaction for a specific day. Combines raw NDJSON files into a single compacted file per source.",
  method: "post",
  hide: env.NODE_ENV === "production",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        day: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .openapi({
            description: "Day to compact in YYYY-MM-DD format",
            example: "2026-02-12",
          }),
        delete_source_files: z.boolean().default(false).openapi({
          description: "Whether to delete raw files after successful compaction",
          example: false,
        }),
      }),
      "Body of the request for manual compaction"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        result: compactionResultSchema,
      }),
      "The result of the compaction"
    ),
    ...openApiErrorResponses,
  },
})

export type CompactRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type CompactResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerCompactV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { day, delete_source_files: deleteSourceFiles } = c.req.valid("json")

    const key = await keyAuth(c)

    if (!key.project.workspace.isMain) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "Only main workspace can trigger manual compaction",
      })
    }

    if (!c.env.LAKEHOUSE) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Lakehouse storage not configured",
      })
    }

    const result: CompactionResult = await handleCompactionForDay(c.env, day, deleteSourceFiles)

    if (!result.success) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.error ?? "Compaction failed",
      })
    }

    return c.json({ result }, HttpStatusCodes.OK)
  })
