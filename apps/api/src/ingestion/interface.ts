import { type LakehouseEventForSource, getLakehouseSourceCurrentVersion } from "@unprice/lakehouse"
import type { IngestionQueueConsumerMessage } from "./message"

export const EVENTS_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("events")

export type IngestionPipelineEvent = LakehouseEventForSource<"events">

export type IngestionRejectionReason =
  | "CUSTOMER_NOT_FOUND"
  | "INVALID_ENTITLEMENT_CONFIGURATION"
  | "INVALID_AGGREGATION_PROPERTIES"
  | "NO_MATCHING_ENTITLEMENT"
  | "UNROUTABLE_EVENT"

export type IngestionOutcome = {
  rejectionReason?: IngestionRejectionReason
  state: "processed" | "rejected"
}

export type CustomerQueueGroup = {
  customerId: string
  messages: IngestionQueueConsumerMessage[]
  projectId: string
}
