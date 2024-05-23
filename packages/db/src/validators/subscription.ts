import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import { subscriptions } from "../schema/subscriptions"
import { planVersionExtendedSchema } from "./planVersionFeatures"

export const subscriptionMetadataSchema = z.object({
  externalId: z.string().optional(),
})

const itemSchema = z.object({
  itemType: z.enum(["feature", "addon"]),
  quantity: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  itemId: z.string(),
  slug: z.string().optional(),
})

// stripe won't allow more than 250 items in a single invoice
export const subscriptionItemsSchema = z
  .array(itemSchema)
  .superRefine((items, ctx) => {
    if (items.length > 250) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Total items for the subscription should be less than 250",
        path: [0, "quantity"],
        fatal: true,
      })

      return false
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      if (item?.quantity && item.limit && item.quantity > item.limit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Quantity is required for feature items",
          path: [i, "quantity"],
          fatal: true,
        })

        return false
      }
    }

    return true
  })
  .refine((items) => {
    if (items.length > 250) {
      return false
    }
    return true
  }, "Total items for the subscription should be less than 250")

export const subscriptionSelectSchema = createSelectSchema(subscriptions, {
  metadata: subscriptionMetadataSchema,
  items: subscriptionItemsSchema,
})
export const subscriptionInsertSchema = createInsertSchema(subscriptions, {
  metadata: subscriptionMetadataSchema,
  items: subscriptionItemsSchema,
}).partial({
  id: true,
  projectId: true,
})

export const subscriptionExtendedSchema = subscriptionSelectSchema
  .pick({
    id: true,
    planVersionId: true,
    customerId: true,
    status: true,
    items: true,
    metadata: true,
  })
  .extend({
    planVersion: planVersionExtendedSchema,
  })

export type Subscription = z.infer<typeof subscriptionSelectSchema>
export type InsertSubscription = z.infer<typeof subscriptionInsertSchema>
export type SubscriptionItem = z.infer<typeof itemSchema>
export type SubscriptionExtended = z.infer<typeof subscriptionExtendedSchema>
