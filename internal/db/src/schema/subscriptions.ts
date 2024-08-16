import { eq, relations } from "drizzle-orm"
import {
  boolean,
  foreignKey,
  integer,
  json,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import type { z } from "zod"

import { pgTableProject } from "../utils/_table"
import { cuid, projectID, timestamps } from "../utils/sql"
import type { subscriptionMetadataSchema } from "../validators/subscriptions"
import { customers } from "./customers"
import {
  collectionMethodEnum,
  startCycleEnum,
  subscriptionStatusEnum,
  typeSubscriptionEnum,
  whenToBillEnum,
} from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { versions } from "./planVersions"
import { projects } from "./projects"
import { usage } from "./usage"

// subscriptions contains the information about the subscriptions of the customers to different items
// like plans, addons, etc.
// when the subscription billing cycle ends, we create a record in another table called invoices (phases) with the items of the subscription
// a customer could be subscribed to multiple items at the same time
// we calculate the entitlements of the subscription based on the items of the subscription and save them in a redis cache to avoid calculating them every time
// also we can use binmanry to store the data in a more efficient way in redis
export const subscriptions = pgTableProject(
  "subscriptions",
  {
    ...projectID,
    ...timestamps,
    // customer to get the payment info from that customer
    customerId: cuid("customers_id").notNull(),

    // payment method id of the customer - if not set, the first payment method will be used
    defaultPaymentMethodId: text("default_payment_method_id"),

    // data from plan version when the subscription was created
    // payment provider configured for the plan. This should not changed after the subscription is created
    // plan version has the payment provider configured, currency and all the other data needed to create the invoice
    // every item in the subscription is linked to a plan version: features, addons, etc.
    planVersionId: cuid("plan_version_id").notNull(),
    // TODO: support addons - every addon should have a subscription
    // addonId: cuid("addon_id"),
    type: typeSubscriptionEnum("type").default("plan").notNull(),

    // prorate the subscription when the subscription is created in the middle of the billing period
    prorated: boolean("prorated").default(true),

    // ************ billing data defaults ************
    // this data normally comes from the plan version but we can override it when creating the subscription
    // whenToBill: pay_in_advance - pay_in_arrear
    whenToBill: whenToBillEnum("when_to_bill").default("pay_in_advance").notNull(),
    // when to start each cycle for this subscription -
    startCycle: startCycleEnum("start_cycle").default("first_day_of_month").notNull(), // null means the first day of the month
    // used for generating invoices -
    gracePeriod: integer("grace_period").default(0), // 0 means no grace period to pay the invoice
    // ************ billing data defaults ************

    timezone: varchar("timezone", { length: 32 }).notNull().default("UTC"),

    // subscription trial period
    // TODO: I can configure this from the plan version
    // TODO: we could override this when creating the subscription, otherwise use planVersion data
    trialDays: integer("trial_days").default(0),
    trialEndsAt: timestamp("trial_ends", {
      mode: "date",
      withTimezone: true,
      precision: 3,
    }),

    startDate: timestamp("start_date", {
      mode: "date",
      withTimezone: true,
      precision: 3,
    }).notNull(),

    endDate: timestamp("end_date", {
      mode: "date",
      withTimezone: true,
      precision: 3,
    }),

    // auto renew the subscription every billing period
    autoRenew: boolean("auto_renew").default(true),

    collectionMethod: collectionMethodEnum("collection_method")
      .notNull()
      .default("charge_automatically"),
    // whether the subscription is new or not. New means that the subscription was created in the current billing period
    isNew: boolean("is_new").default(true),

    // TODO: support plan changes
    // plan change means that the customer has changed the plan in the current billing period. This is used to calculate the proration, entitlements, etc from billing period to billing period
    // planChanged: boolean("plan_changed").default(false),

    // status of the subscription - active, inactive, canceled, paused, etc.
    status: subscriptionStatusEnum("status").default("active"),

    // metadata for the subscription
    metadata: json("metadata").$type<z.infer<typeof subscriptionMetadataSchema>>(),

    /**
     * If a user requests to downgrade, we mark the workspace and downgrade it after the next
     * billing happened.
     */
    nextPlanVersionTo: text("next_plan_version_to"),

    // when the plan was changed - it's used to prevent the customer from changing the plan in the last 30 days
    planChangedAt: timestamp("plan_changed", {
      mode: "date",
      withTimezone: true,
      precision: 3,
    }),

    // next subscription id is the id of the subscription that will be created when the user changes the plan
    nextSubscriptionId: cuid("next_subscription_id"),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "subscriptions_pkey",
    }),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "subscriptions_customer_id_fkey",
    }),
    planversionfk: foreignKey({
      columns: [table.planVersionId, table.projectId],
      foreignColumns: [versions.id, versions.projectId],
      name: "subscriptions_planversion_id_fkey",
    }),
    uniqueplansub: uniqueIndex("unique_active_planversion_subscription")
      .on(table.customerId, table.planVersionId, table.projectId)
      .where(eq(table.status, "active")),
  })
)

export const subscriptionItems = pgTableProject(
  "subscription_items",
  {
    ...projectID,
    ...timestamps,
    // how many units of the feature the user is subscribed to
    // null means the feature is usage based
    units: integer("units"),
    subscriptionId: cuid("subscription_id").notNull(),
    featurePlanVersionId: cuid("feature_plan_version_id").notNull(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "subscription_items_pkey",
    }),
    subscriptionfk: foreignKey({
      columns: [table.subscriptionId, table.projectId],
      foreignColumns: [subscriptions.id, subscriptions.projectId],
      name: "subscription_items_subscription_id_fkey",
    }).onDelete("cascade"),
    featurefk: foreignKey({
      columns: [table.featurePlanVersionId, table.projectId],
      foreignColumns: [planVersionFeatures.id, planVersionFeatures.projectId],
      name: "subscription_items_plan_version_id_fkey",
    }),
  })
)

export const subscriptionItemRelations = relations(subscriptionItems, ({ one, many }) => ({
  subscription: one(subscriptions, {
    fields: [subscriptionItems.subscriptionId, subscriptionItems.projectId],
    references: [subscriptions.id, subscriptions.projectId],
  }),
  featurePlanVersion: one(planVersionFeatures, {
    fields: [subscriptionItems.featurePlanVersionId, subscriptionItems.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
  usages: many(usage),
}))

export const subscriptionRelations = relations(subscriptions, ({ one, many }) => ({
  project: one(projects, {
    fields: [subscriptions.projectId],
    references: [projects.id],
  }),
  customer: one(customers, {
    fields: [subscriptions.customerId, subscriptions.projectId],
    references: [customers.id, customers.projectId],
  }),
  planVersion: one(versions, {
    fields: [subscriptions.planVersionId, subscriptions.projectId],
    references: [versions.id, versions.projectId],
  }),
  items: many(subscriptionItems),
}))
