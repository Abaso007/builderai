import { getToken } from "@auth/core/jwt"
import { createRoute } from "@hono/zod-openapi"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { createRealtimeTicket } from "~/auth/ticket"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["analytics"]

export const route = createRoute({
  path: "/v1/analytics/realtime/ticket",
  operationId: "analytics.getRealtimeTicket",
  summary: "issue realtime websocket ticket",
  description:
    "Issue a short-lived ticket for customer realtime websocket access. The ticket is scoped to user, project, and customer.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customer_id: z.string().openapi({
          description: "The customer ID to scope realtime access",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        project_id: z.string().openapi({
          description: "The project ID to scope realtime access",
          example: "project_1H7KQFLr7RepUyQBKdnvY",
        }),
        expires_in_seconds: z.number().int().min(60).max(3600).optional().openapi({
          description: "Realtime ticket lifetime in seconds",
          example: 3600,
        }),
      }),
      "Realtime ticket request payload"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        ticket: z.string(),
        expires_at: z.number().int(),
        user_id: z.string(),
        project_id: z.string(),
        customer_id: z.string(),
      }),
      "Realtime websocket ticket"
    ),
    ...openApiErrorResponses,
  },
})

export type GetRealtimeTicketRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type GetRealtimeTicketResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetRealtimeTicketV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      customer_id: customerId,
      project_id: projectId,
      expires_in_seconds: expiresInSecondsInput,
    } = c.req.valid("json")
    const authorization = c.req.header("authorization")?.replace("Bearer ", "").trim()

    if (!authorization) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "Session token is required",
      })
    }

    const sessionName =
      c.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token"

    const requestHeaders = new Headers(c.req.raw.headers)
    requestHeaders.set("cookie", `${sessionName}=${authorization}`)

    const token = await getToken({
      req: new Request(c.req.url, {
        headers: requestHeaders,
      }),
      secret: c.env.AUTH_SECRET,
      raw: false,
      salt: sessionName,
      secureCookie: c.env.NODE_ENV === "production",
    })

    if (!token) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      })
    }

    const now = Math.floor(Date.now() / 1000)
    if (token.exp && token.exp <= now) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "Session expired",
      })
    }

    const userId = token.id as string | undefined
    if (!userId?.startsWith("usr_")) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "Unauthorized",
      })
    }

    const { customer } = c.get("services")
    const { err: customerErr, val: customerData } = await customer.getCustomer(customerId)

    if (customerErr) {
      throw customerErr
    }

    if (!customerData) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    if (customerData.projectId !== projectId) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "Customer does not belong to this project",
      })
    }

    const expiresInSeconds = expiresInSecondsInput ?? 3600
    const ticket = await createRealtimeTicket({
      secret: c.env.AUTH_SECRET,
      userId,
      projectId,
      customerId,
      expiresInSeconds,
    })

    return c.json(
      {
        ticket,
        expires_at: now + expiresInSeconds,
        user_id: userId,
        project_id: projectId,
        customer_id: customerId,
      },
      HttpStatusCodes.OK
    )
  })
