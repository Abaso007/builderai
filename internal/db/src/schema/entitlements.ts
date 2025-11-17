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
import type {
  entitlementGrantsSnapshotSchema,
  entitlementMetadataSchema,
} from "../validators/entitlements"
import type { resetConfigSchema } from "../validators/shared"
import { customers } from "./customers"
import {
  aggregationMethodEnum,
  entitlementMergingPolicyEnum,
  grantTypeEnum,
  subjectTypeEnum,
  typeFeatureEnum,
} from "./enums"
import { planVersionFeatures } from "./planVersionFeatures"
import { projects } from "./projects"
import { subscriptionItems } from "./subscriptions"

// entitlements are a snapshot of the grants grouped by subject and feature
// if there are more than one grant for the same subject and feature, the entitlements will be merged using the merging policy
// but still having them inside grants as json for billing attribution
// the uniqueness is based on the customerId, featureSlug
// IMPORTANT: All grants for the same featureSlug MUST have the same:
//   - featureType
//   - resetConfig
//   - aggregationMethod
// Only limit, units, and hardLimit can differ (merged by priority)
// The effective values are stored directly in the entitlement for performance
export const entitlements = pgTableProject(
  "entitlements",
  {
    ...projectID,
    ...timestamps,
    customerId: cuid("customer_id").notNull(),
    featureSlug: varchar("feature_slug", { length: 64 }).notNull(),

    // Effective configuration (must be same across all grants)
    featureType: typeFeatureEnum("feature_type").notNull(),
    resetConfig: json("reset_config").$type<z.infer<typeof resetConfigSchema>>(),
    aggregationMethod: aggregationMethodEnum("aggregation_method").notNull(), // ADD THIS

    // Computed from active grants
    limit: integer("limit"), // null = unlimited
    hardLimit: boolean("hard_limit").notNull().default(false),

    // timezone for the entitlement come from the subscription and help us calculate the reset policy
    timezone: varchar("timezone", { length: 32 }).notNull().default("UTC"),
    currentCycleStartAt: bigint("current_cycle_start_at", { mode: "number" }).notNull(),
    currentCycleEndAt: bigint("current_cycle_end_at", { mode: "number" }).notNull(),

    // Usage tracking (mutable)
    currentCycleUsage: numeric("current_cycle_usage").notNull().default("0"),
    accumulatedUsage: numeric("accumulated_usage").notNull().default("0"),

    // merging policy for the entitlement - sum, max, min, replace, etc.
    // sum limits, max limit, min limit, replace limit and units
    // this normally is decided by the feature type
    mergingPolicy: entitlementMergingPolicyEnum("merging_policy").notNull().default("sum"),

    // Cache invalidation ----------------------------
    computedAt: bigint("computed_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),

    // next revalidate at is the date when the entitlement will be revalidated
    // often times is the same as the cycle end at
    nextRevalidateAt: bigint("next_revalidate_at", { mode: "number" }).notNull(),
    // last sync at is the date when the entitlement was last synced with the database
    lastSyncAt: bigint("last_sync_at", { mode: "number" }).notNull(),

    // Version is string because it's a hash of the grants
    // every time the grants are recomputed, the version is updated
    version: varchar("version", { length: 64 }).notNull().default(""),

    // grants snapshot is the snapshot of the grants that were applied to the customer at the time of the entitlement
    // grants are consumed by priority, so the higher priority will be consumed first
    // usage records are associated to the entitlement and the grant id for billing attribution
    grants: json("grants")
      .$type<z.infer<typeof entitlementGrantsSnapshotSchema>[]>()
      .notNull()
      .default([]),

    // metadata for the entitlement
    metadata: json("metadata").$type<z.infer<typeof entitlementMetadataSchema>>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "pk_entitlement",
    }),
    // Unique constraint: one entitlement per subject + feature
    uniqueSubjectFeature: unique("unique_subject_feature").on(
      table.projectId,
      table.customerId,
      table.featureSlug
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
    type: grantTypeEnum("type").notNull(),
    // subscription item id is the id of the subscription item that the grant is applied to
    subscriptionItemId: cuid("subscription_item_id"),
    subjectType: subjectTypeEnum("subject_type").notNull(),
    // id of the subject to which the grant is applied
    // when project is the subject, the subjectId is the projectId
    // all customers with that subjectId will have the grant applied
    subjectId: cuid("subject_id").notNull(),
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
    // when the grant is deleted, we store the date when it was deleted
    deletedAt: bigint("deleted_at", { mode: "number" }),

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
