import { relations } from "drizzle-orm"
import { index, json, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

import { projectID, tenantID, timestamps } from "../utils/sql"
import { project } from "./project"

export const canva = pgTable(
  "canva",
  {
    ...projectID,
    ...tenantID,
    ...timestamps,
    slug: text("slug").notNull().unique(),
    content: json("content"),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, {
        onDelete: "cascade",
      }),
  },
  (table) => {
    return {
      canvaProjectInx: index("canva_project_id_idx").on(table.projectId),
      canvaInx: uniqueIndex("canva_key_slug").on(table.slug),
      canvaTenantIdInx: index("canva_tenant_uidx").on(table.tenantId),
    }
  }
)

export const canvasRelations = relations(canva, ({ one }) => ({
  project: one(project, {
    fields: [canva.projectId],
    references: [project.id],
  }),
}))
