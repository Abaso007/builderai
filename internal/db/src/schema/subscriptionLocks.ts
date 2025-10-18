import { bigint, primaryKey, uniqueIndex, varchar } from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"

export const subscriptionLocks = pgTableProject(
  "subscription_locks",
  {
    ...projectID,
    ...timestamps,
    subscriptionId: varchar("subscription_id", { length: 32 }).notNull(),
    ownerToken: varchar("owner_token", { length: 64 }).notNull(),
    expiresAt: bigint("expires_at_m", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.subscriptionId], name: "subscription_locks_pk" }),
    idx: uniqueIndex("subscription_locks_idx").on(t.projectId, t.subscriptionId),
  })
)
