import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { planVersionExtendedSchema, subscriptionSelectSchema } from "@unprice/db/validators"

import { protectedWorkspaceProcedure } from "../../../trpc"

export const mySubscriptions = protectedWorkspaceProcedure
  .input(z.void())
  .output(
    z.object({
      subscriptions: subscriptionSelectSchema
        .extend({
          planVersion: planVersionExtendedSchema,
        })
        .array(),
    })
  )
  .query(async (opts) => {
    const workspace = opts.ctx.workspace
    const customerId = workspace.unPriceCustomerId

    if (!customerId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "You are not a customer of this workspace",
      })
    }

    const customerData = await opts.ctx.db.query.customers.findFirst({
      with: {
        subscriptions: {
          with: {
            planVersion: {
              with: {
                planFeatures: {
                  with: {
                    feature: true,
                  },
                },
                plan: true,
              },
            },
          },
          orderBy: (subscription, { desc }) => [desc(subscription.createdAtM)],
        },
      },
      where: (customer, { eq }) => eq(customer.id, customerId),
    })

    if (!customerData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "You are not subscribed to this workspace",
      })
    }

    return {
      subscriptions: customerData.subscriptions,
    }
  })
