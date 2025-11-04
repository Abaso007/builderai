import { not, relations } from "drizzle-orm"
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  json,
  numeric,
  primaryKey,
  unique,
  varchar,
} from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { projectID } from "../utils/sql"

import type { z } from "zod"
import { cuid, timestamps } from "../utils/fields"
import type { entitlementGrantsSnapshotSchema } from "../validators/entitlements"
import type { ResetConfig } from "../validators/shared"
import { customers } from "./customers"
import { typeFeatureEnum } from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { projects } from "./projects"
import { subscriptionItems } from "./subscriptions"

// TODO: this should be named customer entitlements
// entitlements are a snapshot of the grants groupd by subject and feature
// if there are more than one grant for the same subject and feature, the entitlements will be merged using the merging policy
// but still having them inside grants as json for billing attribution
// the uniqueness is based on the customerId, featureSlug
// entitlements need to have the same effectiveLimit, effectiveUnits, effectiveHardLimit and effectiveResetConfig as the grants if not the priority will be used to merge them
export const entitlements = pgTableProject(
  "entitlements",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    featureSlug: varchar("feature_slug").notNull(),
    // if feature type is different on different grants, the grant from subscription will be used.
    featureType: typeFeatureEnum("feature_type").notNull(),

    // Computed from active grants
    effectiveAt: bigint("effective_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    effectiveLimit: integer("effective_limit"), // null = unlimited
    effectiveUnits: integer("effective_units"),
    effectiveHardLimit: boolean("effective_hard_limit").notNull().default(false),
    effectiveResetConfig: json("effective_reset_config").$type<ResetConfig>(),

    // timezone for the entitlement come from the subscription and help us calculate the reset policy
    timezone: varchar("timezone", { length: 32 }).notNull().default("UTC"),

    // Usage tracking (mutable)
    currentCycleUsage: numeric("current_cycle_usage").notNull().default("0"),
    accumulatedUsage: numeric("accumulated_usage").notNull().default("0"),

    // Cycle management
    cycleStartAt: bigint("cycle_start_at", { mode: "number" }).notNull(),
    cycleEndAt: bigint("cycle_end_at", { mode: "number" }),
    lastResetAt: bigint("last_reset_at", { mode: "number" }).notNull(),

    // merging policy for the entitlement - sum, max, min, replace, etc.
    // sum limits and units, max limit, min limit, replace limit and units
    // this normally is decided by the feature type
    mergingPolicy: varchar("merging_policy").notNull().default("sum"),

    // Cache invalidation ----------------------------
    computedAt: bigint("computed_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),

    // next revalidate at is the date when the entitlement will be revalidated
    // often times is the same as the cycle end at
    nextRevalidateAt: bigint("next_revalidate_at", { mode: "number" }).notNull(),

    // Increments when grants are recomputed, used for split-brain mitigation
    version: integer("version").notNull().default(0),

    // grants snapshot is the snapshot of the grants that were applied to the customer at the time of the entitlement
    // grants are consumed by priority, so the higher priority will be consumed first
    // usage records are associated to the entitlement and the grant id for billing attribution
    grants: json("grants").$type<z.infer<typeof entitlementGrantsSnapshotSchema>[]>(),

    lastUsageUpdateAt: bigint("last_usage_update_at", { mode: "number" }).notNull(),

    // metadata for the entitlement
    metadata: json("metadata").$type<{
      [key: string]: string | number | boolean | null
    }>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_entitlement",
    }),
    // Unique constraint: one entitlement per subject+feature combination
    uniqueSubjectFeature: unique("unique_subject_feature").on(
      table.projectId,
      table.customerId,
      table.featureSlug
    ),
    // Composite index for fast lookups with version checking
    idxSubjectFeatureComputed: index("idx_entitlements_subject_feature_computed").on(
      table.projectId,
      table.customerId,
      table.featureSlug,
      table.computedAt
    ),
    // Index for grant version checking
    idxVersion: index("idx_entitlements_version").on(table.projectId, table.version),
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "project_id_fkey",
    }),
    customerfk: foreignKey({
      columns: [table.customerId, table.projectId],
      foreignColumns: [customers.id, customers.projectId],
      name: "customer_id_fkey",
    }).onDelete("cascade"),
  })
)

// Grants are the limits and overrides that are applied to a feature plan version
// for a given subject (workspace, project, plan, plan_version, customer)
// append only
export const grants = pgTableProject(
  "grants",
  {
    ...projectID,
    ...timestamps,
    // featurePlanVersionId is the id of the feature plan version that the grant is applied to
    featurePlanVersionId: cuid("feature_plan_version_id").notNull(),
    // what is the source of the grant?
    // TODO: add enum with subscription, manual, promotion, trial, etc.
    type: varchar("type").notNull(),
    // subscription item id is the id of the subscription item that the grant is applied to
    subscriptionItemId: cuid("subscription_item_id"),
    // TODO: add enum with project, plan, plan_version, customer, etc.
    subjectType: varchar("subject_type").notNull(),
    // id of the subject to which the grant is applied
    // when project is the subject, the subjectId is the projectId
    // all customers with that subjectId will have the grant applied
    subjectId: varchar("subject_id").notNull(),
    // priority defines the merge order higher priority will be consumed first, comes from the type of the grant
    // subscription priority 10
    // trial priority 80
    // promotion priority 90
    // manual priority 100
    priority: integer("priority").notNull().default(0),
    effectiveAt: bigint("effective_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    // when updating a grant, we set the deleted flag to true and create a new one
    // this is useful to keep append only history of the grants and reproduce any entitlement state at any time
    deleted: boolean("deleted").notNull().default(false),

    // ****************** overrides from plan version feature ******************
    // we have it here so we can override them if needed
    // limit is the limit of the feature that the customer is entitled to
    limit: integer("limit"),
    // hard limit is true if the limit is hard and cannot be exceeded
    hardLimit: boolean("hard_limit").notNull().default(false),
    // amount of units the grant gives to the subject
    units: integer("units"),
    // ****************** end overrides from plan version feature ******************

    metadata: json("metadata").$type<{
      [key: string]: string | number | boolean | null
    }>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_grant",
    }),
    // Composite index for finding active grants by subject+feature
    idxSubjectFeatureEffective: index("idx_grants_subject_feature_effective")
      .on(
        table.projectId,
        table.subjectId,
        table.subjectType,
        table.featurePlanVersionId,
        table.effectiveAt,
        table.expiresAt
      )
      .where(not(table.deleted)),
    // Index for grant invalidation queries by featurePlanVersion
    idxFeatureVersionEffective: index("idx_grants_feature_version_effective").on(
      table.projectId,
      table.featurePlanVersionId,
      table.effectiveAt,
      table.expiresAt
    ),
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
    projectfk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "project_id_fkey",
    }),
  })
)

export const entitlementsRelations = relations(entitlements, ({ one }) => ({
  customer: one(customers, {
    fields: [entitlements.customerId, entitlements.projectId],
    references: [customers.id, customers.projectId],
  }),
  project: one(projects, {
    fields: [entitlements.projectId],
    references: [projects.id],
  }),
}))

export const grantsRelations = relations(grants, ({ one }) => ({
  project: one(projects, {
    fields: [grants.projectId],
    references: [projects.id],
  }),
  featurePlanVersion: one(planVersionFeatures, {
    fields: [grants.featurePlanVersionId, grants.projectId],
    references: [planVersionFeatures.id, planVersionFeatures.projectId],
  }),
  subscriptionItem: one(subscriptionItems, {
    fields: [grants.subscriptionItemId, grants.projectId],
    references: [subscriptionItems.id, subscriptionItems.projectId],
  }),
}))
