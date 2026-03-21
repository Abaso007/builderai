import { CloudflareStore } from "@unkey/cache/stores"
import { Analytics } from "@unprice/analytics"
import { createConnection } from "@unprice/db"
import { parseLakehouseEvent } from "@unprice/lakehouse"
import { type AppLogger, createStandaloneRequestLogger } from "@unprice/observability"
import { CacheService } from "@unprice/services/cache"
import { CustomerService } from "@unprice/services/customers"
import {
  GrantsManager,
  type IngestionResolvedState,
  MAX_EVENT_AGE_MS,
} from "@unprice/services/entitlements"
import { NoopMetrics } from "@unprice/services/metrics"
import type { Env } from "~/env"
import { buildIngestionIdempotencyShardName } from "./idempotency"
import {
  type CustomerQueueGroup,
  EVENTS_SCHEMA_VERSION,
  type FeatureVerificationResult,
  type IngestionOutcome,
  type IngestionRejectionReason,
  type IngestionSyncResult,
} from "./interface"
import {
  type IngestionQueueConsumerMessage,
  type IngestionQueueMessage,
  buildIngestionWindowName,
  computeResolvedStatePeriodKey,
  filterMatchingResolvedStates,
  filterResolvedStatesWithValidAggregationPayload,
  ingestionQueueMessageSchema,
  partitionDuplicateQueuedMessages,
  sortQueuedMessages,
} from "./message"

type IngestionCandidateGrants = Parameters<
  GrantsManager["resolveIngestionStatesFromGrants"]
>[0]["grants"]

type PreparedCustomerMessageGroup = {
  candidateGrants: IngestionCandidateGrants
  messages: IngestionQueueConsumerMessage[]
  rejectionReason?: IngestionRejectionReason
}

type PreparedCustomerGrantContext = {
  candidateGrants: IngestionCandidateGrants
  rejectionReason?: IngestionRejectionReason
}

type ProcessMessageParams = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  message: IngestionQueueConsumerMessage
  projectId: string
  rejectionReason?: IngestionRejectionReason
}

type HandleMessageParams = {
  candidateGrants: IngestionCandidateGrants
  customerId: string
  message: IngestionQueueMessage
  projectId: string
  rejectionReason?: IngestionRejectionReason
}

type ApplyResolvedStatesParams = {
  customerId: string
  message: IngestionQueueMessage
  processableStates: IngestionResolvedState[]
  projectId: string
}

type ApplyResolvedStateParams = {
  customerId: string
  enforceLimit: boolean
  message: IngestionQueueMessage
  projectId: string
  state: IngestionResolvedState
}

type MessageLogContext = {
  customerId: string
  eventId: string
  idempotencyKey: string
  projectId: string
}

type IngestionIdempotencyStub = ReturnType<Env["ingestionidempotency"]["getByName"]>
type EntitlementWindowStub = ReturnType<Env["entitlementwindow"]["getByName"]>
type EntitlementWindowApplyResult = {
  allowed: boolean
  deniedReason?: "LIMIT_EXCEEDED"
  message?: string
}

export class IngestionService {
  private readonly customerService: CustomerService
  private readonly grantsManager: GrantsManager
  private readonly env: Env
  private readonly logger: AppLogger
  private readonly now: () => number

  constructor(opts: {
    customerService: CustomerService
    grantsManager: GrantsManager
    env: Env
    logger: AppLogger
    now?: () => number
  }) {
    this.customerService = opts.customerService
    this.env = opts.env
    this.logger = opts.logger
    this.grantsManager = opts.grantsManager
    this.now = opts.now ?? (() => Date.now())
  }

  // TODO: for EU countries we have to keep the stub in the EU namespace
  // private getStub(
  //   name: string,
  //   locationHint?: DurableObjectLocationHint
  // ): DurableObjectStub<DurableObjectUsagelimiter> {
  //   // jurisdiction is only available in production
  //   if (this.stats.isEUCountry && this.env.APP_ENV === "production") {
  //     const euSubnamespace = this.namespace.jurisdiction("eu")
  //     const euStub = euSubnamespace.get(euSubnamespace.idFromName(name), {
  //       locationHint,
  //     })

  //     return euStub
  //   }

  //   return this.namespace.get(this.namespace.idFromName(name), {
  //     locationHint,
  //   })
  // }

  public async consumeBatch(batch: MessageBatch<IngestionQueueMessage>): Promise<void> {
    const validMessages = parseBatchMessages(batch, this.logger)

    if (validMessages.length === 0) {
      this.logger.debug("No messages to process")
      return
    }

    // we deduplicate given the messages to avoid calling the DO multiple times
    // if the events are the same
    const { duplicates, unique } = partitionDuplicateQueuedMessages(validMessages)

    // ack duplicates
    ackDuplicateMessages(duplicates, this.logger)

    if (unique.length === 0) {
      this.logger.debug("no unique messages to process")
      return
    }

    // group by customer so the DO is hit and we take advantage of the state in memory
    for (const group of groupMessagesByCustomer(unique)) {
      await this.processCustomerMessages(group)
    }
  }

  public async ingestFeatureSync(params: {
    featureSlug: string
    message: IngestionQueueMessage
  }): Promise<IngestionSyncResult> {
    const { featureSlug, message } = params
    const { customerId, projectId } = message
    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      startAt: Math.max(0, message.timestamp - MAX_EVENT_AGE_MS),
      endAt: message.timestamp,
    })

    if (preparedContext.rejectionReason === "CUSTOMER_NOT_FOUND") {
      const outcome = await this.rejectMessage(message, preparedContext.rejectionReason)
      this.logRejectedMessage({
        customerId,
        message,
        projectId,
        rejectionReason: outcome.rejectionReason,
      })

      return this.toSyncResult({
        allowed: false,
        outcome,
      })
    }

    if (preparedContext.rejectionReason) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: preparedContext.rejectionReason,
      })
    }

    const resolvedState = await this.resolveSyncFeatureState({
      candidateGrants: preparedContext.candidateGrants,
      customerId,
      featureSlug,
      message,
      projectId,
    })

    if (!("streamId" in resolvedState)) {
      this.logRejectedMessage({
        customerId,
        message,
        projectId,
        rejectionReason: resolvedState.rejectionReason,
      })

      return this.toSyncResult({
        allowed: false,
        outcome: resolvedState,
      })
    }

    const applyResult = await this.applyResolvedState({
      customerId,
      enforceLimit: true, // throw if limit is hit since is sync check
      message,
      projectId,
      state: resolvedState,
    })

    if (!applyResult) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: "UNROUTABLE_EVENT",
      })
    }

    if (!applyResult.allowed) {
      return this.rejectSyncMessage({
        customerId,
        message,
        projectId,
        rejectionReason: applyResult.deniedReason ?? "LIMIT_EXCEEDED",
        messageText: applyResult.message,
      })
    }

    const outcome = await this.publishOutcome(message, {
      state: "processed",
    })

    return this.toSyncResult({
      allowed: true,
      outcome,
    })
  }

  public async verifyFeatureStatus(params: {
    customerId: string
    featureSlug: string
    projectId: string
    timestamp: number
  }): Promise<FeatureVerificationResult> {
    const { customerId, featureSlug, projectId, timestamp } = params
    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      startAt: Math.max(0, timestamp - MAX_EVENT_AGE_MS),
      endAt: timestamp,
    })

    if (preparedContext.rejectionReason === "CUSTOMER_NOT_FOUND") {
      return {
        allowed: false,
        featureSlug,
        status: "customer_not_found",
        timestamp,
      }
    }

    const resolvedFeatureStateResult = await this.grantsManager.resolveFeatureStateAtTimestamp({
      customerId,
      featureSlug,
      grants: preparedContext.candidateGrants,
      projectId,
      timestamp,
    })

    if (resolvedFeatureStateResult.err) {
      this.logger.warn("invalid active grant configuration for feature verification", {
        customerId,
        error: resolvedFeatureStateResult.err.message,
        featureSlug,
        projectId,
        timestamp,
      })

      return {
        allowed: false,
        featureSlug,
        message: resolvedFeatureStateResult.err.message,
        status: "invalid_entitlement_configuration",
        timestamp,
      }
    }

    const resolvedFeatureState = resolvedFeatureStateResult.val

    if (resolvedFeatureState.kind === "feature_missing") {
      return {
        allowed: false,
        featureSlug,
        status: "feature_missing",
        timestamp,
      }
    }

    if (resolvedFeatureState.kind === "feature_inactive") {
      return {
        allowed: false,
        featureSlug,
        status: "feature_inactive",
        timestamp,
      }
    }

    if (resolvedFeatureState.kind === "non_usage") {
      return {
        allowed: true,
        featureSlug,
        featureType: resolvedFeatureState.entitlement.featureType,
        status: "non_usage",
        timestamp,
      }
    }

    const { state } = resolvedFeatureState
    const periodKey = computeResolvedStatePeriodKey(state, timestamp)

    if (!periodKey) {
      this.logger.warn("unable to resolve feature verification period key", {
        customerId,
        featureSlug,
        projectId,
        streamId: state.streamId,
        timestamp,
      })

      return {
        allowed: false,
        featureSlug,
        featureType: "usage",
        message: "Unable to resolve the current meter window for this feature",
        status: "invalid_entitlement_configuration",
        timestamp,
      }
    }

    const enforcementState = await this.getEntitlementWindowStub({
      customerId,
      periodKey,
      projectId,
      streamId: state.streamId,
    }).getEnforcementState({
      limit: state.limit,
      meterId: state.meterConfig.eventId,
      overageStrategy: state.overageStrategy,
    })

    return {
      allowed: !enforcementState.isLimitReached,
      featureSlug,
      featureType: "usage",
      isLimitReached: enforcementState.isLimitReached,
      limit: enforcementState.limit,
      meterConfig: state.meterConfig,
      method: state.meterConfig.aggregationMethod,
      overageStrategy: state.overageStrategy,
      periodKey,
      status: "usage",
      streamEndAt: state.streamEndAt,
      streamId: state.streamId,
      streamStartAt: state.streamStartAt,
      timestamp,
      usage: enforcementState.usage,
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
      const preparedGroup = await this.prepareCustomerMessageGroup({
        customerId,
        messages,
        projectId,
      })

      if (preparedGroup.rejectionReason === "CUSTOMER_NOT_FOUND") {
        for (const message of preparedGroup.messages) {
          await this.rejectMessageWithoutIdempotency({
            customerId,
            message,
            projectId,
            rejectionReason: preparedGroup.rejectionReason,
          })
        }
        return
      }

      // once we are sure the customer exists and there are grants that can resolve the event,
      // then we can call the DO
      for (const message of preparedGroup.messages) {
        await this.processMessage({
          candidateGrants: preparedGroup.candidateGrants,
          customerId,
          message,
          projectId,
          rejectionReason: preparedGroup.rejectionReason,
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
   * Process one queued event for the customer after the batch-level grant lookup.
   */
  private async processMessage(params: ProcessMessageParams): Promise<void> {
    const { candidateGrants, customerId, message, projectId, rejectionReason } = params
    const now = this.now()
    const idempotencyKey = message.body.idempotencyKey
    const logContext: MessageLogContext = {
      projectId,
      customerId,
      eventId: message.body.id,
      idempotencyKey,
    }

    const idempotencyStub = this.getIdempotencyStub(projectId, customerId, idempotencyKey)

    let claimedIdempotency = false

    try {
      const idempotency = await idempotencyStub.begin({
        idempotencyKey,
        now,
      })

      if (idempotency.decision === "duplicate") {
        this.handleDuplicateDecision(message)
        return
      }

      if (idempotency.decision === "busy") {
        this.handleBusyDecision(message, idempotency.retryAfterSeconds)
        return
      }

      claimedIdempotency = true

      // if all those validations are good then lets process the message
      const outcome = await this.handleMessage({
        candidateGrants,
        customerId,
        message: message.body,
        projectId,
        rejectionReason,
      })

      if (outcome.state === "rejected") {
        this.logRejectedMessage({
          customerId,
          message: message.body,
          projectId,
          rejectionReason: outcome.rejectionReason,
        })
      }

      await idempotencyStub.complete({
        idempotencyKey,
        now: this.now(),
        result: JSON.stringify(outcome),
      })

      message.ack()
    } catch (error) {
      this.logger.error("raw ingestion message processing failed", {
        ...logContext,
        error,
      })

      if (claimedIdempotency) {
        await this.abortClaim(idempotencyStub, idempotencyKey, logContext)
      }

      message.retry()
    }
  }

  private async handleMessage(params: HandleMessageParams): Promise<IngestionOutcome> {
    const { candidateGrants, customerId, message, projectId, rejectionReason } = params

    // we validate the rejection here because we need to check every idempotency key no matter what
    // double counting is the worse
    if (rejectionReason) {
      return this.rejectMessage(message, rejectionReason)
    }

    const processableStates = await this.resolveProcessableStates({
      candidateGrants,
      customerId,
      message,
      projectId,
    })

    if (!Array.isArray(processableStates)) {
      return processableStates
    }

    await this.applyResolvedStates({
      customerId,
      message,
      processableStates,
      projectId,
    })

    return this.publishOutcome(message, {
      state: "processed",
    })
  }

  private async resolveSyncFeatureState(params: {
    candidateGrants: IngestionCandidateGrants
    customerId: string
    featureSlug: string
    message: IngestionQueueMessage
    projectId: string
  }): Promise<IngestionOutcome | IngestionResolvedState> {
    const { candidateGrants, customerId, featureSlug, message, projectId } = params
    const resolvedFeatureStateResult = await this.grantsManager.resolveFeatureStateAtTimestamp({
      customerId,
      featureSlug,
      grants: candidateGrants,
      projectId,
      timestamp: message.timestamp,
    })

    if (resolvedFeatureStateResult.err) {
      this.logger.warn("invalid active grant configuration for sync ingestion", {
        projectId,
        customerId,
        featureSlug,
        event: message,
        error: resolvedFeatureStateResult.err.message,
      })

      return this.rejectMessage(message, "INVALID_ENTITLEMENT_CONFIGURATION")
    }

    if (resolvedFeatureStateResult.val.kind !== "usage") {
      this.logger.debug("no matching sync ingestion entitlement", {
        event: message,
        featureSlug,
        state: resolvedFeatureStateResult.val.kind,
      })

      return this.rejectMessage(message, "NO_MATCHING_ENTITLEMENT")
    }

    const processableStates = await this.filterProcessableResolvedStates({
      message,
      states: [resolvedFeatureStateResult.val.state],
    })

    if (!Array.isArray(processableStates)) {
      return processableStates
    }

    const [processableState] = processableStates

    if (!processableState) {
      return this.rejectMessage(message, "UNROUTABLE_EVENT")
    }

    return processableState
  }

  private async prepareCustomerMessageGroup(params: {
    customerId: string
    messages: IngestionQueueConsumerMessage[]
    projectId: string
  }): Promise<PreparedCustomerMessageGroup> {
    const { customerId, messages, projectId } = params

    const earliestMessage = messages[0]?.body
    const latestMessage = messages.at(-1)?.body

    if (!earliestMessage || !latestMessage) {
      return {
        messages,
        candidateGrants: [],
      }
    }

    const preparedContext = await this.prepareCustomerGrantContext({
      customerId,
      projectId,
      startAt: Math.max(0, earliestMessage.timestamp - MAX_EVENT_AGE_MS),
      endAt: latestMessage.timestamp,
    })

    return {
      messages,
      candidateGrants: preparedContext.candidateGrants,
      rejectionReason: preparedContext.rejectionReason,
    }
  }

  private async prepareCustomerGrantContext(params: {
    customerId: string
    endAt: number
    projectId: string
    startAt: number
  }): Promise<PreparedCustomerGrantContext> {
    const { customerId, endAt, projectId, startAt } = params

    // We need to validate the customer exists before sending bs to the DO
    const { err: customerErr, val: customer } = await this.customerService.getCustomer(customerId)

    if (customerErr) {
      throw customerErr
    }

    if (!customer || customer.projectId !== projectId) {
      return {
        candidateGrants: [],
        rejectionReason: "CUSTOMER_NOT_FOUND",
      }
    }

    const { err, val } = await this.grantsManager.getGrantsForCustomer({
      projectId,
      customerId,
      startAt,
      endAt,
    })

    if (err) {
      throw err
    }

    const candidateGrants = val.grants

    return {
      candidateGrants,
      rejectionReason: hasUsageGrant(candidateGrants) ? undefined : "NO_MATCHING_ENTITLEMENT",
    }
  }

  private getIdempotencyStub(
    projectId: string,
    customerId: string,
    idempotencyKey: string
  ): IngestionIdempotencyStub {
    // the only reliable way to dedupe events here is using DO's
    // since we can have pressure of this because the limits are 1k rps
    // we shard this in 32 DOs more than enough, but we can increase later.
    // we shard by idempotencyKey so the same keys landed in the same DO
    return this.env.ingestionidempotency.getByName(
      buildIngestionIdempotencyShardName({
        appEnv: this.env.APP_ENV,
        projectId,
        customerId,
        idempotencyKey,
      })
    )
  }

  private handleDuplicateDecision(message: IngestionQueueConsumerMessage): void {
    this.logger.debug("duplicated event", {
      event: message.body,
    })
    message.ack()
  }

  private handleBusyDecision(
    message: IngestionQueueConsumerMessage,
    retryAfterSeconds?: number
  ): void {
    this.logger.debug("idempotency busy", {
      event: message.body,
    })
    message.retry(
      retryAfterSeconds
        ? {
            delaySeconds: retryAfterSeconds,
          }
        : undefined
    )
  }

  private async abortClaim(
    idempotencyStub: IngestionIdempotencyStub,
    idempotencyKey: string,
    logContext: MessageLogContext
  ): Promise<void> {
    await idempotencyStub.abort({ idempotencyKey }).catch((abortError) => {
      this.logger.error("failed to release ingestion idempotency claim", {
        ...logContext,
        error: abortError,
      })
    })
  }

  private async publishOutcome(
    message: IngestionQueueMessage,
    outcome: IngestionOutcome
  ): Promise<IngestionOutcome> {
    await this.publishPipelineEvent({
      handledAt: this.now(),
      message,
      outcome,
    })

    return outcome
  }

  private async rejectMessage(
    message: IngestionQueueMessage,
    rejectionReason: IngestionRejectionReason
  ): Promise<IngestionOutcome> {
    return this.publishOutcome(message, {
      state: "rejected",
      rejectionReason,
    })
  }

  private async rejectMessageWithoutIdempotency(params: {
    customerId: string
    message: IngestionQueueConsumerMessage
    projectId: string
    rejectionReason: "CUSTOMER_NOT_FOUND"
  }): Promise<void> {
    const { customerId, message, projectId, rejectionReason } = params
    const outcome = await this.rejectMessage(message.body, rejectionReason)
    this.logRejectedMessage({
      customerId,
      message: message.body,
      projectId,
      rejectionReason: outcome.rejectionReason,
    })

    message.ack()
  }

  private async resolveProcessableStates(params: {
    candidateGrants: IngestionCandidateGrants
    customerId: string
    message: IngestionQueueMessage
    projectId: string
  }): Promise<IngestionOutcome | IngestionResolvedState[]> {
    const { candidateGrants, customerId, message, projectId } = params
    const resolvedStatesResult = await this.grantsManager.resolveIngestionStatesFromGrants({
      customerId,
      grants: candidateGrants,
      projectId,
      timestamp: message.timestamp,
    })

    if (resolvedStatesResult.err) {
      this.logger.warn("invalid active grant configuration for ingestion", {
        projectId,
        customerId,
        event: message,
        error: resolvedStatesResult.err.message,
      })

      return this.rejectMessage(message, "INVALID_ENTITLEMENT_CONFIGURATION")
    }

    return this.filterProcessableResolvedStates({
      message,
      states: resolvedStatesResult.val,
    })
  }

  private async filterProcessableResolvedStates(params: {
    message: IngestionQueueMessage
    states: IngestionResolvedState[]
  }): Promise<IngestionOutcome | IngestionResolvedState[]> {
    const { message, states } = params
    const matchingStates = filterMatchingResolvedStates({
      states,
      event: message,
    })

    if (matchingStates.length === 0) {
      this.logger.debug("no matching ingestion streams", {
        event: message,
        outcome: {
          state: "rejected",
          rejectionReason: "UNROUTABLE_EVENT",
        } satisfies IngestionOutcome,
      })

      return this.rejectMessage(message, "UNROUTABLE_EVENT")
    }

    // before going to the DO let's validate the event itself has the property the meter is using
    // for the aggregation
    const processableStates = filterResolvedStatesWithValidAggregationPayload({
      states: matchingStates,
      event: message,
    })

    if (processableStates.length === 0) {
      this.logger.debug("invalid aggregation payload", {
        event: message,
        outcome: {
          state: "rejected",
          rejectionReason: "INVALID_AGGREGATION_PROPERTIES",
        } satisfies IngestionOutcome,
      })

      return this.rejectMessage(message, "INVALID_AGGREGATION_PROPERTIES")
    }

    return processableStates
  }

  private async applyResolvedStates(params: ApplyResolvedStatesParams): Promise<void> {
    const { customerId, message, processableStates, projectId } = params

    for (const state of processableStates) {
      await this.applyResolvedState({
        customerId,
        enforceLimit: false,
        message,
        projectId,
        state,
      })
    }
  }

  private async applyResolvedState(
    params: ApplyResolvedStateParams
  ): Promise<EntitlementWindowApplyResult | null> {
    const { customerId, enforceLimit, message, projectId, state } = params

    // This keeps counters stable across mid-cycle grant changes.
    const periodKey = computeResolvedStatePeriodKey(state, message.timestamp)

    if (!periodKey) {
      this.logger.debug("period key doesn't exist")
      return null
    }

    const stub = this.getEntitlementWindowStub({
      customerId,
      periodKey,
      projectId,
      streamId: state.streamId,
    })

    // call the DO and apply the usage
    return stub.apply({
      event: {
        id: message.id,
        slug: message.slug,
        timestamp: message.timestamp,
        properties: message.properties,
      },
      idempotencyKey: message.idempotencyKey,
      projectId,
      customerId,
      streamId: state.streamId,
      featureSlug: state.featureSlug,
      periodKey,
      meters: [state.meterConfig],
      limit: state.limit,
      overageStrategy: state.overageStrategy,
      enforceLimit,
    })
  }

  private getEntitlementWindowStub(params: {
    customerId: string
    periodKey: string
    projectId: string
    streamId: string
  }): EntitlementWindowStub {
    return this.env.entitlementwindow.getByName(
      buildIngestionWindowName({
        appEnv: this.env.APP_ENV,
        customerId: params.customerId,
        periodKey: params.periodKey,
        projectId: params.projectId,
        streamId: params.streamId,
      })
    )
  }

  private logRejectedMessage(params: {
    customerId: string
    message: IngestionQueueMessage
    projectId: string
    rejectionReason?: IngestionRejectionReason
  }): void {
    const { customerId, message, projectId, rejectionReason } = params
    this.logger.warn("raw ingestion message rejected", {
      projectId,
      customerId,
      eventId: message.id,
      eventSlug: message.slug,
      idempotencyKey: message.idempotencyKey,
      rejectionReason,
    })
  }

  private async rejectSyncMessage(params: {
    customerId: string
    message: IngestionQueueMessage
    messageText?: string
    projectId: string
    rejectionReason: IngestionRejectionReason
  }): Promise<IngestionSyncResult> {
    const { customerId, message, messageText, projectId, rejectionReason } = params
    const outcome = await this.rejectMessage(message, rejectionReason)
    this.logRejectedMessage({
      customerId,
      message,
      projectId,
      rejectionReason: outcome.rejectionReason,
    })

    return this.toSyncResult({
      allowed: false,
      message: messageText,
      outcome,
    })
  }

  private toSyncResult(params: {
    allowed: boolean
    message?: string
    outcome: IngestionOutcome
  }): IngestionSyncResult {
    const { allowed, message, outcome } = params
    return {
      allowed,
      message,
      rejectionReason: outcome.rejectionReason,
      state: outcome.state,
    }
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

function parseBatchMessages(
  batch: MessageBatch<IngestionQueueMessage>,
  logger: AppLogger
): IngestionQueueConsumerMessage[] {
  return batch.messages.flatMap((message) => {
    const parsed = ingestionQueueMessageSchema.safeParse(message.body)

    if (!parsed.success) {
      // this shouldn't happen since the ingestion endpoint validates the payload
      // just in case
      logger.error("dropping malformed ingestion queue message", {
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
}

function ackDuplicateMessages(
  duplicates: IngestionQueueConsumerMessage[],
  logger: AppLogger
): void {
  for (const duplicate of duplicates) {
    logger.debug("dropping duplicate ingestion queue message from same batch", {
      projectId: duplicate.body.projectId,
      customerId: duplicate.body.customerId,
      eventId: duplicate.body.id,
      idempotencyKey: duplicate.body.idempotencyKey,
    })
    duplicate.ack()
  }
}

function hasUsageGrant(candidateGrants: IngestionCandidateGrants): boolean {
  return candidateGrants.some(
    (grant) =>
      grant.featurePlanVersion.featureType === "usage" &&
      Boolean(grant.featurePlanVersion.meterConfig)
  )
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
    grantsManager: services.grantsManager,
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
  grantsManager: GrantsManager
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
    grantsManager: new GrantsManager({
      db,
      logger: params.logger,
    }),
  }
}
