import { relations, sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  json,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { cuid, timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import type { invoiceMetadataSchema } from "../validators/subscriptions"
import { billingPeriods } from "./billingPeriods"
import { customers } from "./customers"
import {
  collectionMethodEnum,
  currencyEnum,
  invoiceItemKindEnum,
  invoiceStatusEnum,
  invoiceTypeEnum,
  paymentProviderEnum,
  whenToBillEnum,
} from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { projects } from "./projects"
import { subscriptionItems, subscriptionPhases, subscriptions } from "./subscriptions"

export const invoices = pgTableProject(
  "invoices",
  {
    ...projectID,
    ...timestamps,
    // Is it necessary to have the subscription id?
    subscriptionId: cuid("subscription_id").notNull(),
    subscriptionPhaseId: cuid("subscription_phase_id").notNull(),
    customerId: cuid("customer_id").notNull(),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    // date the invoice was issued
    issueDate: bigint("issue_date_m", { mode: "number" }),
    // type of invoice charges (flat, usage, hybrid)
    type: invoiceTypeEnum("type").notNull().default("hybrid"),
    requiredPaymentMethod: boolean("required_payment_method").notNull().default(false),
    paymentMethodId: text("payment_method_id"),
    // keeps date in here to enforce uniqueness and show a billing period in the UI
    cycleStartAt: bigint("cycle_start_at_m", { mode: "number" }).notNull(),
    cycleEndAt: bigint("cycle_end_at_m", { mode: "number" }).notNull(),
    whenToBill: whenToBillEnum("when_to_bill").notNull().default("pay_in_advance"),
    collectionMethod: collectionMethodEnum("collection_method")
      .notNull()
      .default("charge_automatically"),
    // payment provider for the plan - stripe, paypal, lemonsquezee etc.
    paymentProvider: paymentProviderEnum("payment_providers").notNull(),
    // currency of the plan
    currency: currencyEnum("currency").notNull(),
    // sent at is the date when the invoice was sent to the customer
    sentAt: bigint("sent_at_m", { mode: "number" }),
    // TODO: create a new table for payment attempts when necessary
    paymentAttempts:
      json("payment_attempts").$type<
        {
          status: string
          createdAt: number
        }[]
      >(),
    // when the invoice is due and ready to be billed
    dueAt: bigint("due_at_m", { mode: "number" }).notNull(),
    paidAt: bigint("paid_at_m", { mode: "number" }),
    // ----------------- amounts --------------------------------
    // amount of the credit used to pay the invoice
    amountCreditUsed: integer("amount_credit_used").default(0),
    // subtotal of the invoice before the credit is applied
    subtotal: integer("subtotal").default(0).notNull(),
    // total amount of the invoice after the credit is applied
    total: integer("total").default(0).notNull(),
    // ----------------- amounts --------------------------------
    invoicePaymentProviderId: text("invoice_payment_provider_id"),
    invoicePaymentProviderUrl: text("invoice_payment_provider_url"),
    // when the subscription is considered past due
    pastDueAt: bigint("past_due_at_m", { mode: "number" }).notNull(),
    metadata: json("metadata").$type<z.infer<typeof invoiceMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "invoices_pkey",
    }),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "invoices_subscription_id_fkey",
    }).onDelete("cascade"),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "invoices_customer_id_fkey",
    }).onDelete("cascade"),
    subscriptionPhasefk: foreignKey({
      columns: [table.subscriptionPhaseId, table.projectId],
      foreignColumns: [subscriptionPhases.id, subscriptionPhases.projectId],
      name: "invoices_subscription_phase_id_fkey",
    }).onDelete("cascade"),
    // project fk
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "invoices_project_id_fkey",
    }).onDelete("cascade"),
    periodUnique: uniqueIndex("invoices_period_unique").on(
      table.projectId,
      table.subscriptionId,
      table.subscriptionPhaseId,
      table.customerId,
      table.cycleStartAt,
      table.cycleEndAt
    ),
  })
)

export const invoiceItems = pgTableProject(
  "invoice_items",
  {
    ...projectID,
    ...timestamps,
    invoiceId: cuid("invoice_id").notNull(),
    // required when the kind is period
    billingPeriodId: cuid("billing_period_id"), // null for manual/one-off adjustments like discounts, taxes, etc.
    // required when the kind is subscription
    subscriptionItemId: cuid("subscription_item_id"),
    // required when the kind is feature
    featurePlanVersionId: cuid("feature_plan_version_id"),
    // kind of the invoice item
    kind: invoiceItemKindEnum("kind").notNull().default("period"),

    // amounts in cents — totals at line level
    unitAmountCents: integer("unit_amount_cents"),
    quantity: integer("quantity").default(1).notNull(),
    // subtotal (before discounts/taxes), discount and tax amounts are optional for now
    amountSubtotal: integer("amount_subtotal").notNull().default(0),
    amountTotal: integer("amount_total").notNull().default(0),

    // period of the line (can differ per item even if invoice has a single window)
    cycleStartAt: bigint("cycle_start_at_m", { mode: "number" }).notNull(),
    cycleEndAt: bigint("cycle_end_at_m", { mode: "number" }).notNull(),

    // flags and metadata
    proration: boolean("proration").notNull().default(false),
    prorationFactor: doublePrecision("proration_factor"),
    description: varchar("description", { length: 200 }),
    // provider-level mapping for reconciliation
    itemProviderId: text("item_provider_id"),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.id, table.projectId],
      name: "invoice_items_pkey",
    }),
    invoicefk: foreignKey({
      columns: [table.invoiceId, table.projectId],
      foreignColumns: [invoices.id, invoices.projectId],
      name: "invoice_items_invoice_id_fkey",
    }).onDelete("cascade"),
    billingPeriodfk: foreignKey({
      columns: [table.billingPeriodId, table.projectId],
      foreignColumns: [billingPeriods.id, billingPeriods.projectId],
      name: "invoice_items_billing_period_id_fkey",
    }).onDelete("set null"),
    subscriptionItemfk: foreignKey({
      columns: [table.subscriptionItemId, table.projectId],
      foreignColumns: [subscriptionItems.id, subscriptionItems.projectId],
      name: "invoice_items_subscription_item_id_fkey",
    }).onDelete("set null"),
    featurePlanVersionfk: foreignKey({
      columns: [table.featurePlanVersionId, table.projectId],
      foreignColumns: [planVersionFeatures.id, planVersionFeatures.projectId],
      name: "invoice_items_feature_plan_version_id_fkey",
    }).onDelete("set null"),
    // avoid duplicate materialization of the same billing period into the same invoice
    uqByCycle: uniqueIndex("invoice_items_cycle_unique")
      .on(table.projectId, table.invoiceId, table.billingPeriodId)
      .where(sql`${table.billingPeriodId} IS NOT NULL AND ${table.invoiceId} IS NOT NULL`),
    // avoid having the same external id multiple times in the same invoice
    uqByItemProviderId: uniqueIndex("invoice_items_item_provider_id_unique")
      .on(table.projectId, table.invoiceId, table.itemProviderId)
      .where(sql`${table.itemProviderId} IS NOT NULL`),
    idxByInvoice: index("invoice_items_invoice_idx").on(table.projectId, table.invoiceId),
    idxByBillingPeriod: index("invoice_items_cycle_idx").on(table.projectId, table.billingPeriodId),
    idxBySubItem: index("invoice_items_sub_item_idx").on(table.projectId, table.subscriptionItemId),
  })
)

export const creditGrants = pgTableProject(
  "credit_grants",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    currency: currencyEnum("currency").notNull(),
    paymentProvider: paymentProviderEnum("payment_providers").notNull(),
    totalAmount: integer("total_amount").notNull(),
    amountUsed: integer("amount_used").notNull().default(0),
    expiresAt: bigint("expires_at_m", { mode: "number" }),
    reason: varchar("reason", { length: 64 }),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    active: boolean("active").notNull().default(true),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.projectId], name: "credit_grants_pkey" }),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "credit_grants_customer_id_fkey",
    }),
  })
)

// when an invoice is paid, we need to apply the credit grants to the invoice
// this is used to handle the credits for the invoices, normally due to cancel or downgrade mid cycle
export const invoiceCreditApplications = pgTableProject(
  "invoice_credit_applications",
  {
    ...projectID,
    ...timestamps,
    invoiceId: cuid("invoice_id").notNull(),
    creditGrantId: cuid("credit_grant_id").notNull(),
    amountApplied: integer("amount_applied").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.id, table.projectId],
      name: "invoice_credit_applications_pkey",
    }),
    invoicefk: foreignKey({
      columns: [table.invoiceId, table.projectId],
      foreignColumns: [invoices.id, invoices.projectId],
      name: "invoice_credit_applications_invoice_id_fkey",
    }).onDelete("cascade"),
    grantfk: foreignKey({
      columns: [table.creditGrantId, table.projectId],
      foreignColumns: [creditGrants.id, creditGrants.projectId],
      name: "invoice_credit_applications_credit_grant_id_fkey",
    }).onDelete("cascade"),
  })
)

export const invoiceItemRelations = relations(invoiceItems, ({ one, many }) => ({
  invoice: one(invoices, {
    fields: [invoiceItems.invoiceId, invoiceItems.projectId],
    references: [invoices.id, invoices.projectId],
  }),
  invoiceCreditApplications: many(invoiceCreditApplications),
  invoiceItems: many(invoiceItems),
  billingPeriod: one(billingPeriods, {
    fields: [invoiceItems.billingPeriodId, invoiceItems.projectId],
    references: [billingPeriods.id, billingPeriods.projectId],
  }),
  subscriptionItem: one(subscriptionItems, {
    fields: [invoiceItems.subscriptionItemId, invoiceItems.projectId],
    references: [subscriptionItems.id, subscriptionItems.projectId],
  }),
  featurePlanVersion: one(planVersionFeatures, {
    fields: [invoiceItems.featurePlanVersionId, invoiceItems.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
  project: one(projects, {
    fields: [invoiceItems.projectId],
    references: [projects.id],
  }),
}))

export const invoiceRelations = relations(invoices, ({ one, many }) => ({
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId, invoices.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  project: one(projects, {
    fields: [invoices.projectId],
    references: [projects.id],
  }),
  subscriptionPhase: one(subscriptionPhases, {
    fields: [invoices.subscriptionPhaseId, invoices.projectId],
    references: [subscriptionPhases.id, subscriptionPhases.projectId],
  }),
  creditGrants: many(creditGrants),
  customer: one(customers, {
    fields: [invoices.customerId, invoices.projectId],
    references: [customers.id, customers.projectId],
  }),
}))

export const creditGrantsRelations = relations(creditGrants, ({ one }) => ({
  customer: one(customers, {
    fields: [creditGrants.customerId, creditGrants.projectId],
    references: [customers.id, customers.projectId],
  }),
  project: one(projects, {
    fields: [creditGrants.projectId],
    references: [projects.id],
  }),
}))

export const invoiceCreditApplicationsRelations = relations(
  invoiceCreditApplications,
  ({ one }) => ({
    invoice: one(invoices, {
      fields: [invoiceCreditApplications.invoiceId, invoiceCreditApplications.projectId],
      references: [invoices.id, invoices.projectId],
    }),
    creditGrant: one(creditGrants, {
      fields: [invoiceCreditApplications.creditGrantId, invoiceCreditApplications.projectId],
      references: [creditGrants.id, creditGrants.projectId],
    }),
    project: one(projects, {
      fields: [invoiceCreditApplications.projectId],
      references: [projects.id],
    }),
  })
)
