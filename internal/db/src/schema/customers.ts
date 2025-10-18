import { relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  json,
  numeric,
  primaryKey,
  text,
  varchar,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { projectID } from "../utils/sql"

import { cuid, id, timestamps } from "../utils/fields"
import type {
  customerMetadataSchema,
  customerSessionMetadataSchema,
  stripePlanVersionSchema,
  stripeSetupSchema,
} from "../validators/customer"

import { currencyEnum } from "./enums"
import { invoices } from "./invoices"
import { planVersionFeatures } from "./planVersionFeatures"
import { projects } from "./projects"
import { subscriptionItems, subscriptionPhases, subscriptions } from "./subscriptions"

export const customers = pgTableProject(
  "customers",
  {
    ...projectID,
    ...timestamps,
    email: text("email").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    metadata: json("metadata").$type<z.infer<typeof customerMetadataSchema>>(),
    stripeCustomerId: text("stripe_customer_id").unique("stripe_customer_unique"),
    active: boolean("active").notNull().default(true),
    isMain: boolean("is_main").notNull().default(false),
    // all customers will have a default currency - normally the currency of the project
    defaultCurrency: currencyEnum("default_currency").notNull().default("USD"),
    timezone: varchar("timezone", { length: 32 }).notNull().default("UTC"),
  },
  (table) => ({
    email: index("email").on(table.email),
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_customer",
    }),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "project_id_fkey",
    }),
  })
)

// entitlements are the actual features that are assigned to a customer
// normally this would match with subscription items but we need to add a way to
// add entitlements to a plan version/customer without having to create a subscription item
// since the subscription item is more of a billing concept and the entitlement is more of a
// usage/access concept.
export const customerEntitlements = pgTableProject(
  "customer_entitlements",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    // subscriptionId the subscription that the customer is entitled to
    subscriptionId: cuid("subscription_id").notNull(),
    // featurePlanVersionId is the id of the feature plan version that the customer is entitled to
    featurePlanVersionId: cuid("feature_plan_version_id").notNull(),
    // subscriptionPhaseId is the id of the subscription phase that the customer is entitled to
    subscriptionPhaseId: cuid("subscription_phase_id").notNull(),
    // subscriptionItemId is the id of the subscription item that the customer is entitled to
    // can be null if the entitlement is custom
    subscriptionItemId: cuid("subscription_item_id"),

    // ****************** defaults from plan version features ******************
    // we have it here so we can override them if needed
    // limit is the limit of the feature that the customer is entitled to
    limit: integer("limit"),
    // units are tied to the amount of units the customer bought at checkout time
    units: integer("units"),
    // currentCycleUsage is the usage of the feature that the customer has used
    currentCycleUsage: numeric("current_cycle_usage").notNull().default("0"),
    // accumulatedUsage is the accumulated usage of the feature that the customer has used
    accumulatedUsage: numeric("accumulated_usage").notNull().default("0"),
    // realtime features are updated in realtime, others are updated periodically
    realtime: boolean("realtime").notNull().default(false),
    // ****************** end defaults from plan version features ******************

    // entitlements are tied to a phase, in the phase there are all dates related to when
    // the entitlement is valid or considered expired
    // resetedAt is the date when the entitlement usage was reseted
    // normally this is set by the subscription renew event
    resetedAt: bigint("reseted_at", { mode: "number" }).notNull(),

    // active is true if the entitlement is active
    active: boolean("active").notNull().default(true),

    // if it's a custom entitlement, it's not tied to a subscription item and it's not billed
    isCustom: boolean("is_custom").notNull().default(false),

    // entitlements are updated on a regular basis
    lastUsageUpdateAt: bigint("last_usage_update_at", { mode: "number" })
      .notNull()
      .default(0)
      .$defaultFn(() => Date.now()),
    metadata: json("metadata").$type<{
      [key: string]: string | number | boolean | null
    }>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_customer_entitlement",
    }),
    featurePlanVersionfk: foreignKey({
      columns: [table.featurePlanVersionId, table.projectId],
      foreignColumns: [planVersionFeatures.id, planVersionFeatures.projectId],
      name: "feature_plan_version_id_fkey",
    }).onDelete("no action"),
    subscriptionItemfk: foreignKey({
      columns: [table.subscriptionItemId, table.projectId],
      foreignColumns: [subscriptionItems.id, subscriptionItems.projectId],
      name: "subscription_item_id_fkey",
    }).onDelete("cascade"),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "customer_id_fkey",
    }).onDelete("cascade"),
    subscriptionPhasefk: foreignKey({
      columns: [table.subscriptionPhaseId, table.projectId],
      foreignColumns: [subscriptionPhases.id, subscriptionPhases.projectId],
      name: "subscription_phase_id_fkey",
    }).onDelete("cascade"),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "subscription_id_fkey",
    }).onDelete("cascade"),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "project_id_fkey",
    }),
  })
)

// when customer are created, we need to perform a session flow to add a payment method
// this table allows us to keep track of the params we need to perform the flow
// after the payment method is added in the payment provider
export const customerSessions = pgTableProject("customer_sessions", {
  ...id,
  ...timestamps,
  customer: json("customer").notNull().$type<z.infer<typeof stripeSetupSchema>>(),
  planVersion: json("plan_version").notNull().$type<z.infer<typeof stripePlanVersionSchema>>(),
  metadata: json("metadata").$type<z.infer<typeof customerSessionMetadataSchema>>(),
})

export const customerEntitlementsRelations = relations(customerEntitlements, ({ one }) => ({
  subscriptionItem: one(subscriptionItems, {
    fields: [customerEntitlements.subscriptionItemId, customerEntitlements.projectId],
    references: [subscriptionItems.id, subscriptionItems.projectId],
  }),
  featurePlanVersion: one(planVersionFeatures, {
    fields: [customerEntitlements.featurePlanVersionId, customerEntitlements.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
  subscription: one(subscriptions, {
    fields: [customerEntitlements.subscriptionId, customerEntitlements.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  subscriptionPhase: one(subscriptionPhases, {
    fields: [customerEntitlements.subscriptionPhaseId, customerEntitlements.projectId],
    references: [subscriptionPhases.id, subscriptionPhases.projectId],
  }),
  customer: one(customers, {
    fields: [customerEntitlements.customerId, customerEntitlements.projectId],
    references: [customers.id, customers.projectId],
  }),
  project: one(projects, {
    fields: [customerEntitlements.projectId],
    references: [projects.id],
  }),
}))

export const customersRelations = relations(customers, ({ one, many }) => ({
  project: one(projects, {
    fields: [customers.projectId],
    references: [projects.id],
  }),
  subscriptions: many(subscriptions),
  entitlements: many(customerEntitlements),
  invoices: many(invoices),
  // paymentMethods: many(customerPaymentMethods),
}))
