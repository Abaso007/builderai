import {
  reportUsageAggregates,
  usageAggregates,
  usageRecords,
  verificationAggregates,
  verifications,
} from "./schema"

export type UsageRecord = typeof usageRecords.$inferSelect
export type NewUsageRecord = typeof usageRecords.$inferInsert
export type Verification = typeof verifications.$inferSelect
export type NewVerification = typeof verifications.$inferInsert
export type UsageAggregate = typeof usageAggregates.$inferSelect
export type VerificationAggregate = typeof verificationAggregates.$inferSelect
export type ReportUsageAggregate = typeof reportUsageAggregates.$inferSelect

export const schema = {
  usageRecords,
  verifications,
  usageAggregates,
  verificationAggregates,
  reportUsageAggregates,
}

export type Schema = typeof schema
