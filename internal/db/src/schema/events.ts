import { relations } from "drizzle-orm"
import { json, primaryKey, uniqueIndex, varchar } from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { timestamps } from "../utils/fields"
import { projectID } from "../utils/sql"
import { projects } from "./projects"

export const events = pgTableProject(
  "events",
  {
    ...projectID,
    ...timestamps,
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    availableProperties: json("available_properties").$type<string[]>(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.id, table.projectId],
      name: "events_pkey",
    }),
    uniqueProjectSlug: uniqueIndex("unique_event_project_slug").on(table.projectId, table.slug),
  })
)

export const eventRelations = relations(events, ({ one }) => ({
  project: one(projects, {
    fields: [events.projectId],
    references: [projects.id],
  }),
}))
