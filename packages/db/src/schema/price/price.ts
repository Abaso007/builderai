import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import { feature, plan } from "./price.sql"

export const planBase = createSelectSchema(plan, {
  id: (schema) => schema.id.cuid2(),
  slug: (schema) =>
    schema.slug
      .trim()
      .toLowerCase()
      .min(3)
      .regex(/^[a-z0-9\-]+$/),
})

export const createPlanSchema = planBase
  .pick({
    slug: true,
    title: true,
    currency: true,
  })
  .extend({
    projectSlug: z.string(),
  })

export type CreatePlan = z.infer<typeof createPlanSchema>

export const updatePlanSchema = planBase
  .pick({
    slug: true,
    id: true,
    content: true,
    tenantId: true,
    projectId: true,
    title: true,
  })
  .partial({
    slug: true,
    projectSlug: true,
  })

export type UpdatePlan = z.infer<typeof updatePlanSchema>

export const featureBase = createSelectSchema(feature, {
  title: (schema) => schema.title.min(3),
  slug: (schema) =>
    schema.slug
      .trim()
      .toLowerCase()
      .min(3)
      .regex(/^[a-z0-9\-]+$/),
}).omit({
  createdAt: true,
  updatedAt: true,
  tenantId: true,
  projectId: true,
})

export const updateFeatureSchema = featureBase
  .pick({
    id: true,
    title: true,
    type: true,
    description: true,
  })
  .partial({
    description: true,
  })
  .extend({
    projectSlug: z.string(),
  })

export const createFeatureSchema = featureBase
  .pick({
    slug: true,
    title: true,
    description: true,
    type: true,
  })
  .partial({
    description: true,
  })
  .extend({
    projectSlug: z.string(),
  })

export type CreateFeature = z.infer<typeof createFeatureSchema>
export type UpdateFeature = z.infer<typeof updateFeatureSchema>
export type Feature = z.infer<typeof featureBase>
