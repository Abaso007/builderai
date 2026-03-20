import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import type { Entitlement } from "@unprice/db/validators"
import {
  type LakehouseEventForSource,
  getLakehouseSourceCurrentVersion,
  parseLakehouseEvent,
} from "@unprice/lakehouse"
import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import { CacheService } from "@unprice/services/cache"
import { CustomerService } from "@unprice/services/customers"
import {
  EntitlementService,
  MemoryEntitlementStorageProvider,
} from "@unprice/services/entitlements"
import { NoopMetrics } from "@unprice/services/metrics"
import type { Env } from "~/env"
import { buildIngestionIdempotencyShardName } from "./idempotency"
import {
  type IngestionQueueConsumerMessage,
  type IngestionQueueMessage,
  buildEntitlementWindowName,
  computeEntitlementPeriodKey,
  filterEntitlementsWithValidAggregationPayload,
  filterMatchingEntitlements,
  ingestionQueueMessageSchema,
  partitionDuplicateQueuedMessages,
  sortQueuedMessages,
} from "./message"

const EVENTS_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("events")

export type IngestionPipelineEvent = LakehouseEventForSource<"events">

type IngestionRejectionReason =
  | "CUSTOMER_NOT_FOUND"
  | "INVALID_AGGREGATION_PROPERTIES"
  | "NO_MATCHING_ENTITLEMENT"
  | "UNROUTABLE_EVENT"

type IngestionOutcome = {
  rejectionReason?: IngestionRejectionReason
  state: "processed" | "rejected"
}

type QueueCustomerService = Pick<CustomerService, "getCustomer">
type QueueEntitlementService = Pick<EntitlementService, "getRelevantEntitlementsForIngestion">

type CustomerQueueGroup = {
  customerId: string
  messages: IngestionQueueConsumerMessage[]
  projectId: string
}

export class IngestionService {
  private readonly customerService: QueueCustomerService
  private readonly entitlementService: QueueEntitlementService
  private readonly env: Env
  private readonly logger: AppLogger
  private readonly now: () => number

  constructor(opts: {
    customerService: QueueCustomerService
    entitlementService: QueueEntitlementService
    env: Env
    logger: AppLogger
    now?: () => number
  }) {
    this.customerService = opts.customerService
    this.env = opts.env
    this.logger = opts.logger
    this.entitlementService = opts.entitlementService
    this.now = opts.now ?? (() => Date.now())
  }

  public async consumeBatch(batch: MessageBatch<IngestionQueueMessage>): Promise<void> {
    const validMessages = batch.messages.flatMap((message) => {
      const parsed = ingestionQueueMessageSchema.safeParse(message.body)

      if (!parsed.success) {
        // this shouldn't happen since the ingestion endpoint validates the payload
        // just in case
        this.logger.error("dropping malformed ingestion queue message", {
          errors: parsed.error.issues,
        })
        message.ack()
        return []
      }

      return [
        {
          ack: message.ack.bind(message),
          body: parsed.data,
          retry: message.retry.bind(message),
        } satisfies IngestionQueueConsumerMessage,
      ]
    })

    if (validMessages.length === 0) {
      this.logger.debug("No messages to process")
      return
    }

    // we deduplicate given the messages to avoid calling the DO multiple times
    // if the events are the same
    const { duplicates, unique } = partitionDuplicateQueuedMessages(validMessages)

    for (const duplicate of duplicates) {
      this.logger.debug("dropping duplicate ingestion queue message from same batch", {
        projectId: duplicate.body.projectId,
        customerId: duplicate.body.customerId,
        eventId: duplicate.body.id,
        idempotencyKey: duplicate.body.idempotencyKey,
      })
      duplicate.ack()
    }

    if (unique.length === 0) {
      this.logger.debug("no unique messages to process")
      return
    }

    // group by customer so the DO is hit and we take advantage of the state in memory
    for (const group of groupMessagesByCustomer(unique)) {
      await this.processCustomerMessages(group)
    }
  }

  public async processCustomerMessages(params: {
    customerId: string
    messages: IngestionQueueConsumerMessage[]
    projectId: string
  }): Promise<void> {
    const { customerId, projectId } = params
    // important to processes them in the same other timestamp
    const messages = [...params.messages].sort(sortQueuedMessages)

    try {
      // We need to validate the customer exists before sending bs to the DO
      const { err: customerErr, val: customer } = await this.customerService.getCustomer(customerId)

      if (customerErr) {
        throw customerErr
      }

      let groupRejectionReason: IngestionRejectionReason | undefined
      let entitlements: Entitlement[] = []

      if (!customer || customer.projectId !== projectId) {
        groupRejectionReason = "CUSTOMER_NOT_FOUND"
      } else {
        // current entitlements or entitlements expired 30 days in the past
        const { err, val } = await this.entitlementService.getRelevantEntitlementsForIngestion({
          projectId,
          customerId,
          historicalDays: 30, // last 30 days to support late arriving from past periods
        })

        if (err) {
          throw err
        }

        entitlements = val

        if (entitlements.length === 0) {
          groupRejectionReason = "NO_MATCHING_ENTITLEMENT"
        }
      }

      // once we are sure the customer exists and there are entitlements listening that event,
      // then we can call the DO
      for (const message of messages) {
        await this.processMessage({
          customerId,
          entitlements,
          message,
          projectId,
          rejectionReason: groupRejectionReason,
        })
      }
    } catch (error) {
      this.logger.error("raw ingestion queue processing failed", {
        projectId,
        customerId,
        error,
      })

      // we retry every message again, if it fails 3 times we send to the DLQ
      for (const message of messages) {
        message.retry()
      }
    }
  }

  /**
   * Process all entitlements of the customer
   * @param params
   * @returns
   */
  private async processMessage(params: {
    customerId: string
    entitlements: Entitlement[]
    message: IngestionQueueConsumerMessage
    projectId: string
    rejectionReason?: IngestionRejectionReason
  }): Promise<void> {
    const { customerId, entitlements, message, projectId, rejectionReason } = params
    const now = this.now()
    const idempotencyKey = message.body.idempotencyKey

    // the only reliable way to dedupe events here is using DO's
    // since we can have pressure of this because the limits are 1k rps
    // we shard this in 32 DOs more than enough, but we can increase later.
    // we shard by idempotencyKey so the same keys landed in the same DO
    const idempotencyStub = this.env.ingestionidempotency.getByName(
      buildIngestionIdempotencyShardName({
        appEnv: this.env.APP_ENV,
        projectId,
        customerId,
        idempotencyKey,
      })
    )

    let claimedIdempotency = false

    try {
      const idempotency = await idempotencyStub.begin({
        idempotencyKey,
        now,
      })

      if (idempotency.decision === "duplicate") {
        this.logger.debug("duplicated event", {
          event: message.body,
        })
        message.ack()
        return
      }

      if (idempotency.decision === "busy") {
        this.logger.debug("idempotency busy", {
          event: message.body,
        })
        message.retry(
          idempotency.retryAfterSeconds
            ? {
                delaySeconds: idempotency.retryAfterSeconds,
              }
            : undefined
        )
        return
      }

      claimedIdempotency = true

      // if all those validations are good then lets process the message
      const outcome = await this.handleMessage({
        customerId,
        entitlements,
        message: message.body,
        projectId,
        rejectionReason,
      })

      if (outcome.state === "rejected") {
        this.logger.warn("raw ingestion message rejected", {
          projectId,
          customerId,
          eventId: message.body.id,
          eventSlug: message.body.slug,
          idempotencyKey,
          rejectionReason: outcome.rejectionReason,
        })
      }

      await idempotencyStub.complete({
        idempotencyKey,
        now: this.now(),
      })
      message.ack()
    } catch (error) {
      this.logger.error("raw ingestion message processing failed", {
        projectId,
        customerId,
        eventId: message.body.id,
        idempotencyKey,
        error,
      })

      if (claimedIdempotency) {
        await idempotencyStub.abort({ idempotencyKey }).catch((abortError) => {
          this.logger.error("failed to release ingestion idempotency claim", {
            projectId,
            customerId,
            eventId: message.body.id,
            idempotencyKey,
            error: abortError,
          })
        })
      }

      message.retry()
    }
  }

  private async handleMessage(params: {
    customerId: string
    entitlements: Entitlement[]
    message: IngestionQueueMessage
    projectId: string
    rejectionReason?: IngestionRejectionReason
  }): Promise<IngestionOutcome> {
    const { customerId, entitlements, message, projectId, rejectionReason } = params

    // we validate the rejection here because we need to check every idempotency key no matter what
    // double counting is the worse
    if (rejectionReason) {
      const outcome: IngestionOutcome = {
        state: "rejected",
        rejectionReason,
      }

      // if there is a rejection already, we write to the audit
      await this.publishPipelineEvent({
        handledAt: this.now(),
        message,
        outcome,
      })

      return outcome
    }

    // get the entitlements listening for the event slug
    const matchingEntitlements = filterMatchingEntitlements({
      entitlements,
      event: message,
    })

    if (matchingEntitlements.length === 0) {
      const outcome: IngestionOutcome = {
        state: "rejected",
        rejectionReason: "UNROUTABLE_EVENT",
      }

      this.logger.debug("no matching entitlements", {
        event: message,
        outcome,
      })

      // save to audit if no entitlements
      await this.publishPipelineEvent({
        handledAt: this.now(),
        message,
        outcome,
      })

      return outcome
    }

    // before going to the DO let's validate the event itself has the property the meter is using
    // for the aggregation
    const processableEntitlements = filterEntitlementsWithValidAggregationPayload({
      entitlements: matchingEntitlements,
      event: message,
    })

    if (processableEntitlements.length === 0) {
      const outcome: IngestionOutcome = {
        state: "rejected",
        rejectionReason: "INVALID_AGGREGATION_PROPERTIES",
      }

      this.logger.debug("invalid aggregation payload", {
        event: message,
        outcome,
      })

      // if the property doesn't exist then we save to audit and reject the event
      await this.publishPipelineEvent({
        handledAt: this.now(),
        message,
        outcome,
      })

      return outcome
    }

    for (const entitlement of processableEntitlements) {
      // this shouldn't happen as we validated before but in case, also make types happy
      if (!entitlement.meterConfig) {
        this.logger.debug("meterConfig doesn't exist")
        continue
      }

      // this is the way DO rotate overtime, generating a new key given the reset config
      // seamlessly reseting limits
      const periodKey = computeEntitlementPeriodKey(entitlement, message.timestamp)

      if (!periodKey) {
        this.logger.debug("period key doesn't exist")
        continue
      }

      // DO for handling entitlement usage
      const stub = this.env.entitlementwindow.getByName(
        buildEntitlementWindowName({
          appEnv: this.env.APP_ENV,
          projectId,
          customerId,
          entitlementId: entitlement.id,
          periodKey,
        })
      )

      // call the DO and apply the usage
      await stub.apply({
        event: {
          id: message.id,
          slug: message.slug,
          timestamp: message.timestamp,
          properties: message.properties,
        },
        idempotencyKey: message.idempotencyKey,
        meters: [entitlement.meterConfig],
        limit: entitlement.limit,
        overageStrategy: entitlement.metadata?.overageStrategy ?? "none",
        enforceLimit: false, // we don't enforce limits here, every valid event that is sent we ingest
      })
    }

    const outcome: IngestionOutcome = {
      state: "processed",
    }

    // send to audit
    await this.publishPipelineEvent({
      handledAt: this.now(),
      message,
      outcome,
    })

    return outcome
  }

  private async publishPipelineEvent(params: {
    handledAt: number
    message: IngestionQueueMessage
    outcome: IngestionOutcome
  }): Promise<void> {
    const pipelineEvent = parseLakehouseEvent("events", {
      event_date: toEventDate(params.message.timestamp),
      schema_version: EVENTS_SCHEMA_VERSION,
      id: params.message.id,
      project_id: params.message.projectId,
      customer_id: params.message.customerId,
      request_id: params.message.requestId,
      idempotency_key: params.message.idempotencyKey,
      slug: params.message.slug,
      timestamp: params.message.timestamp,
      received_at: params.message.receivedAt,
      handled_at: params.handledAt,
      state: params.outcome.state,
      rejection_reason: params.outcome.rejectionReason,
      properties: params.message.properties,
    })

    await this.env.PIPELINE_EVENTS.send([pipelineEvent])
  }
}

function toEventDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export async function consumeIngestionBatch(
  batch: MessageBatch<IngestionQueueMessage>,
  env: Env,
  executionCtx: ExecutionContext
): Promise<void> {
  const batchRequestId = `queue:${Date.now()}`
  const { logger } = createStandaloneRequestLogger({
    requestId: batchRequestId,
  })

  logger.set({
    service: "api",
    request: {
      id: batchRequestId,
    },
    cloud: {
      platform: "cloudflare",
    },
    business: {
      operation: "raw_ingestion_queue_consume",
    },
  })

  const services = createQueueServices({
    env,
    executionCtx,
    logger,
  })

  const service = new IngestionService({
    customerService: services.customerService,
    entitlementService: services.entitlementService,
    env,
    logger,
  })

  await service.consumeBatch(batch)

  await logger.flush().catch((error: Error) => {
    logger.emit("error", "Failed to flush ingestion queue logger", {
      error: error.message,
    })
  })
}

function groupMessagesByCustomer(messages: IngestionQueueConsumerMessage[]): CustomerQueueGroup[] {
  const groups = new Map<string, CustomerQueueGroup>()

  for (const message of messages) {
    const key = `${message.body.projectId}:${message.body.customerId}`
    const existing = groups.get(key)

    if (existing) {
      existing.messages.push(message)
      continue
    }

    groups.set(key, {
      projectId: message.body.projectId,
      customerId: message.body.customerId,
      messages: [message],
    })
  }

  return [...groups.values()].map((group) => ({
    ...group,
    messages: group.messages.sort(sortQueuedMessages),
  }))
}

function createQueueServices(params: {
  env: Env
  executionCtx: ExecutionContext
  logger: AppLogger
}): {
  customerService: CustomerService
  entitlementService: EntitlementService
} {
  const db = createConnection({
    env: params.env.APP_ENV,
    primaryDatabaseUrl: params.env.DATABASE_URL,
    read1DatabaseUrl: params.env.DATABASE_READ1_URL,
    read2DatabaseUrl: params.env.DATABASE_READ2_URL,
    logger: params.env.DRIZZLE_LOG.toString() === "true",
    singleton: false,
  })
  const metrics = new NoopMetrics()
  const waitUntil = (promise: Promise<unknown>) => params.executionCtx.waitUntil(promise)
  const cacheService = new CacheService(
    {
      waitUntil,
    },
    metrics,
    false
  )
  const cloudflareCacheStore =
    params.env.CLOUDFLARE_ZONE_ID &&
    params.env.CLOUDFLARE_API_TOKEN &&
    params.env.CLOUDFLARE_CACHE_DOMAIN &&
    params.env.CLOUDFLARE_ZONE_ID !== "" &&
    params.env.CLOUDFLARE_API_TOKEN !== "" &&
    params.env.CLOUDFLARE_CACHE_DOMAIN !== ""
      ? new CloudflareStore({
          cloudflareApiKey: params.env.CLOUDFLARE_API_TOKEN,
          zoneId: params.env.CLOUDFLARE_ZONE_ID,
          domain: params.env.CLOUDFLARE_CACHE_DOMAIN,
          cacheBuster: "v2",
        })
      : undefined

  cacheService.init(cloudflareCacheStore ? [cloudflareCacheStore] : [])
  const cache = cacheService.getCache()
  const analytics = new Analytics({
    emit: true,
    tinybirdToken: params.env.TINYBIRD_TOKEN,
    tinybirdUrl: params.env.TINYBIRD_URL,
    logger: params.logger,
  })

  return {
    customerService: new CustomerService({
      db,
      logger: params.logger,
      analytics,
      waitUntil,
      cache,
      metrics,
    }),
    entitlementService: new EntitlementService({
      db,
      storage: new MemoryEntitlementStorageProvider({ logger: params.logger }),
      logger: params.logger,
      analytics,
      waitUntil,
      cache,
      metrics,
    }),
  }
}
