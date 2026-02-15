import { createRoute } from "@hono/zod-openapi"
import { verificationResultSchema } from "@unprice/db/validators"
import { endTime } from "hono/timing"
import { startTime } from "hono/timing"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { reportUsageEvents } from "~/util/reportUsageEvents"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/verify",
  operationId: "customers.verify",
  summary: "verify feature",
  description: "Verify if a customer can use a feature",
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
          action: z
            .string()
            .openapi({
              description:
                "The action being performed (e.g., 'read', 'write', 'delete'). Normalized to lowercase with spaces as hyphens.",
              example: "read",
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
          // TODO: turn this into a verify + consume request - better delete it and create a new endpoint to avoid confusion
          usage: z
            .number()
            .openapi({
              description: "The usage to check feature access for, if not provided, it will be 0",
              example: 100,
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
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(verificationResultSchema, "The result of the verify check"),
    ...openApiErrorResponses,
  },
})

export type VerifyRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type VerifyResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerVerifyV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, externalId, featureSlug, metadata, usage, action } = c.req.valid("json")
    const { usagelimiter, customer } = c.get("services")
    const stats = c.get("stats")
    const requestId = c.get("requestId")
    const performanceStart = c.get("performanceStart")
    const requestStartedAt = c.get("requestStartedAt")

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

    // bouncer is explicitly ignored here because we don't want to hurt latency on the verification path
    // also it makes sense to let customer verify the feature so their service continue working
    // event if that means some overage usage

    // start a new timer
    startTime(c, "verify")

    // validate usage from db
    const { err, val: result } = await usagelimiter.verify({
      customerId: resolvedCustomerId,
      featureSlug,
      projectId,
      requestId,
      performanceStart,
      usage,
      // short ttl for dev
      flushTime: c.env.NODE_ENV === "development" ? 5 : undefined,
      // timestamp of the record (stabilized at request start)
      timestamp: requestStartedAt,
      // first-class analytics fields
      country: stats.country,
      region: stats.colo,
      action: action,
      keyId: key.id,
      metadata: metadata ?? null,
    })

    // end the timer
    endTime(c, "verify")

    // send analytics event for the unprice customer
    c.executionCtx.waitUntil(reportUsageEvents(c, {}, "verify"))

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
