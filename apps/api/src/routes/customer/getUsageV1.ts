import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"

import { currentUsageSchema } from "@unprice/db/validators"
import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/getUsage",
  operationId: "customers.getUsage",
  summary: "get usage",
  description: "Get usage for a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        projectId: z
          .string()
          .openapi({
            description: "The project ID",
            example: "prj_1H7KQFLr7RepUyQBKdnvY",
          })
          .optional(),
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      currentUsageSchema.openapi({
        description: "The current usage data for the customer",
      }),
      "The result of the get usage"
    ),
    ...openApiErrorResponses,
  },
})

export type GetUsageRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetUsageResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetUsageV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")
    const { usagelimiter } = c.get("services")
    const now = Date.now()

    // validate the request
    const key = await keyAuth(c)

    const finalProjectId = validateIsAllowedToAccessProject({
      isMain: key.project.isMain ?? false,
      key,
      requestedProjectId: projectId ?? key.project.id,
    })

    const { err, val: result } = await usagelimiter.getCurrentUsage({
      customerId,
      projectId: finalProjectId,
      now,
    })

    if (err) {
      throw err
    }

    return c.json(result, HttpStatusCodes.OK)
  })
