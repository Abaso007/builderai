import { createRoute } from "@hono/zod-openapi"
import { reportUsageResultSchema } from "@unprice/db/validators"
import { endTime, startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { bouncer } from "~/util/bouncer"
import { reportUsageEvents } from "~/util/reportUsageEvents"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/reportUsage",
  operationId: "customers.reportUsage",
  summary: "report usage",
  description: "Report usage for a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z
        .object({
          customerId: z
            .string()
            .openapi({
              description: "The unprice customer ID",
              example: "cus_1H7KQFLr7RepUyQBKdnvY",
            })
            .optional(),
          externalId: z
            .string()
            .openapi({
              description: "The external customer ID provided at sign up",
              example: "user_123",
            })
            .optional(),
          featureSlug: z.string().openapi({
            description: "The feature slug",
            example: "tokens",
          }),
          usage: z.number().openapi({
            description: "The usage",
            example: 30,
          }),
          idempotenceKey: z.string().uuid().openapi({
            description: "The idempotence key",
            example: "123e4567-e89b-12d3-a456-426614174000",
          }),
          action: z
            .string()
            .openapi({
              description:
                "The action being performed (e.g., 'create', 'update', 'delete', 'send-email', 'flush'). Normalized to lowercase with spaces as hyphens.",
              example: "create",
            })
            .optional()
            .transform((v) =>
              v == null || v === "" ? undefined : v.trim().toLowerCase().replace(/\s+/g, "-")
            ),
          metadata: z
            .object({
              source: z.string().optional(),
              resourceId: z.string().optional(),
              resourceType: z.string().optional(),
            })
            .openapi({
              description: "Additional metadata for the usage report",
              example: {
                source: "api",
                resourceId: "123",
                resourceType: "user",
              },
            })
            .optional(),
        })
        .superRefine((data, ctx) => {
          if (!data.customerId && !data.externalId) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Either customerId or externalId is required",
              path: ["customerId", "externalId"],
            })
          }
        }),
      "The usage to report"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(reportUsageResultSchema, "The result of the report usage"),
    ...openApiErrorResponses,
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      reportUsageResultSchema,
      "The limit has been exceeded"
    ),
  },
})

export type ReportUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type ReportUsageResponse = z.infer<
  | (typeof route.responses)[200]["content"]["application/json"]["schema"]
  | (typeof route.responses)[429]["content"]["application/json"]["schema"]
>

export const registerReportUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, externalId, featureSlug, usage, idempotenceKey, metadata, action } =
      c.req.valid("json")
    const { usagelimiter, customer } = c.get("services")
    const stats = c.get("stats")
    const requestId = c.get("requestId")
    const requestStartedAt = c.get("requestStartedAt")
    const performanceStart = c.get("performanceStart")

    // validate the request
    const key = await keyAuth(c)

    const projectId = customerId
      ? await resolveContextProjectId(c, key.projectId, customerId)
      : key.projectId

    let resolvedCustomerId: string

    if (customerId) {
      resolvedCustomerId = customerId
    } else {
      const { err: resolveCustomerErr, val: customerContext } = await customer.resolveCustomerId({
        projectId,
        externalId,
      })

      if (resolveCustomerErr) {
        throw resolveCustomerErr
      }

      resolvedCustomerId = customerContext.customerId
    }

    // check if the customer is blocked
    // ONLY bounce if usage is positive (consuming) because negative usage is a correction
    if (usage >= 0) {
      await bouncer(c, resolvedCustomerId, projectId)
    }

    // start a new timer
    startTime(c, "reportUsage")

    // validate usage from db
    const { err, val: result } = await usagelimiter.reportUsage({
      customerId: resolvedCustomerId,
      featureSlug,
      usage,
      // timestamp of the record (stabilized at request start)
      timestamp: requestStartedAt,
      idempotenceKey,
      // short ttl for dev
      flushTime: c.env.NODE_ENV === "development" ? 5 : undefined,
      projectId,
      requestId,
      performanceStart,
      // first-class analytics fields
      country: stats.country,
      region: stats.colo,
      action: action,
      keyId: key.id,
      metadata: metadata ?? null,
    })

    // end the timer
    endTime(c, "reportUsage")

    // send analytics event for the unprice customer
    c.executionCtx.waitUntil(reportUsageEvents(c, {}, "report-usage"))

    if (err) {
      throw err
    }

    if (result.deniedReason === "LIMIT_EXCEEDED") {
      return c.json(result, HttpStatusCodes.TOO_MANY_REQUESTS)
    }

    return c.json(result, HttpStatusCodes.OK)
  })
