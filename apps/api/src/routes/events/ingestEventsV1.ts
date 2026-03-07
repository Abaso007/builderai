import { createRoute } from "@hono/zod-openapi"
import type { OverageStrategy } from "@unprice/db/validators"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  type MeterConfig,
  type RawEvent,
  computePeriodKey,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import * as HttpStatusCodes from "stoker/http-status-codes"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["ingestion"]
const DAY_MS = 24 * 60 * 60 * 1000

const rawEventSchema = z.object({
  id: z.string().openapi({
    description: "The unique event id",
    example: "evt_123",
  }),
  slug: z.string().openapi({
    description: "The event type",
    example: "tokens.used",
  }),
  timestamp: z.number().openapi({
    description: "Event timestamp in epoch milliseconds",
    example: 1_741_454_800_000,
  }),
  properties: z.record(z.string(), z.unknown()).openapi({
    description: "Arbitrary event properties",
    example: {
      amount: 1,
    },
  }),
})

const ingestRequestSchema = z.object({
  event: rawEventSchema,
  customerId: z.string().openapi({
    description: "The unprice customer id",
    example: "cus_123",
  }),
  entitlementId: z.string().openapi({
    description: "The entitlement id",
    example: "ent_123",
  }),
})

const ingestApplyResultSchema = z.object({
  allowed: z.boolean().openapi({
    description: "Whether the event was accepted by synchronous entitlement window evaluation",
    example: true,
  }),
  deniedReason: z.literal("LIMIT_EXCEEDED").optional().openapi({
    description:
      "Present when the event exceeds strict limit policy in the current entitlement window",
    example: "LIMIT_EXCEEDED",
  }),
  message: z.string().optional().openapi({
    description: "Optional explanatory message from the DO",
    example: "Event already processed",
  }),
})

const acceptedSchema = z.object({
  accepted: z.literal(true).openapi({
    description: "The event was accepted for asynchronous processing only",
    example: true,
  }),
})

type CachedEntitlementVersion = {
  limit: number | null
  overageStrategy: OverageStrategy
  validFrom: number
  validTo: number | null
  interval: "month" | "lifetime"
  anchorDay: number
}

export const route = createRoute({
  path: "/v1/events/ingest",
  operationId: "ingestion.ingestEvent",
  summary: "ingest event",
  description:
    "Ingest an event and synchronously aggregate it into the authoritative DO window with optional strict limit policy",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(ingestRequestSchema, "The event ingestion payload"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ingestApplyResultSchema,
      "The event was synchronously aggregated by the Durable Object"
    ),
    [HttpStatusCodes.ACCEPTED]: jsonContent(
      acceptedSchema,
      "The raw event was accepted, but synchronous DO aggregation was skipped"
    ),
    ...openApiErrorResponses,
  },
})

type IngestRequest = z.infer<typeof ingestRequestSchema>

export const registerIngestEventsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")

    // authenticate the request
    await keyAuth(c)

    try {
      // validate that the event timestamp is not too far in the future or too old
      validateEventTimestamp(body.event.timestamp, Date.now())
    } catch (error) {
      if (
        error instanceof EventTimestampTooFarInFutureError ||
        error instanceof EventTimestampTooOldError
      ) {
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message: error.message,
        })
      }

      throw error
    }

    // 1. send the event to the cloudflare pipeline
    // TODO: should I wait here?
    c.executionCtx.waitUntil(sendToCloudflarePipeline(body.event))

    // 2. get the cached entitlement versions
    // this adds aprox 10ms - 20ms to the request
    const versions = await getCachedEntitlementVersions()

    // 3. find the active entitlement version
    const activeVersion = versions.find(
      (version) =>
        version.validFrom <= body.event.timestamp &&
        (version.validTo === null || body.event.timestamp < version.validTo)
    )

    if (!activeVersion) {
      return c.json({ accepted: true as const }, HttpStatusCodes.ACCEPTED)
    }

    // TODO: implement this later from DB configuration
    // if the entitltment doesn't have meters we use the default meters
    // const defaultMeters = [
    //   {
    //   id: "default_usage",
    //     eventType: body.event.type,
    //     aggregation: { type: "SUM", field: "$usage" },
    //   },
    // ]

    // 4. compute the period key and the DO name
    // this simplifies everything because we don't need to rotate the DOs state, we just pass the new period key
    // Old DOs remain for one month to support late arrival of events, pass that the DO is deleted by alarm
    const periodKey = computeEntitlementPeriodKey(body.event.timestamp, activeVersion)
    // TODO: const entitlementId should come from activeVersion configuration
    // The key should add the environment as well to support multiple environments
    // data base is copied between envs so we differentiate by environment in the key
    const doName = `${body.customerId}:${body.entitlementId}:${periodKey}`
    // we need to improve this to support location hints like usagelimiter DOs
    const id = c.env.entitlementwindow.idFromName(doName)
    const stub = c.env.entitlementwindow.get(id)
    // this add aprox 30ms - 50ms to the request
    const result = await stub.apply({
      event: body.event,
      // this comes from DB configuration for the entitlement
      meters: buildMockMeters(body.event, body.entitlementId),
      limit: activeVersion.limit,
      overageStrategy: activeVersion.overageStrategy,
    })

    return c.json(result, HttpStatusCodes.OK)
  })

async function sendToCloudflarePipeline(_event: RawEvent): Promise<void> {}

async function getCachedEntitlementVersions(): Promise<CachedEntitlementVersion[]> {
  const now = 1773081881795
  return [
    {
      limit: 100,
      overageStrategy: "none",
      validFrom: now - 14 * DAY_MS,
      validTo: now - 7 * DAY_MS,
      interval: "month",
      anchorDay: 1,
    },
    {
      limit: 250,
      overageStrategy: "always",
      validFrom: now - 7 * DAY_MS,
      validTo: null,
      interval: "month",
      anchorDay: 1,
    },
  ]
}

function computeEntitlementPeriodKey(
  eventTimestamp: number,
  activeVersion: CachedEntitlementVersion
): string {
  // TODO: migrate this and use reset config instead
  if (activeVersion.interval === "lifetime") {
    return computePeriodKey({
      now: eventTimestamp,
      effectiveStartDate: activeVersion.validFrom,
      effectiveEndDate: activeVersion.validTo,
      trialEndsAt: null,
      config: {
        name: "ingestion",
        interval: "onetime",
        intervalCount: 1,
        anchor: "dayOfCreation",
        planType: "onetime",
      },
    })
  }

  return computePeriodKey({
    now: eventTimestamp,
    effectiveStartDate: activeVersion.validFrom,
    effectiveEndDate: activeVersion.validTo,
    trialEndsAt: null,
    config: {
      name: "ingestion",
      interval: "month",
      intervalCount: 1,
      anchor: activeVersion.anchorDay,
      planType: "recurring",
    },
  })
}

function buildMockMeters(event: RawEvent, entitlementId: string): MeterConfig[] {
  return [
    {
      eventId: `${entitlementId}:count`,
      eventSlug: event.slug,
      aggregationMethod: "count",
    },
  ]
}

export type IngestEventsRequest = IngestRequest
export type IngestEventsResponse = z.infer<typeof ingestApplyResultSchema>
