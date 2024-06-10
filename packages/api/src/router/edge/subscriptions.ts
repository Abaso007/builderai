import { TRPCError } from "@trpc/server"
import { ZodError, z } from "zod"
import { features } from "./../../../../db/src/schema/features"

import { and, eq } from "@builderai/db"
import * as schema from "@builderai/db/schema"
import * as utils from "@builderai/db/utils"
import type { InsertSubscriptionItem, SubscriptionItem } from "@builderai/db/validators"
import {
  createDefaultSubscriptionConfig,
  subscriptionInsertSchema,
  subscriptionItemsSchema,
  subscriptionSelectSchema,
} from "@builderai/db/validators"

import { waitUntil } from "@vercel/functions"
import {
  createTRPCRouter,
  protectedActiveProjectAdminProcedure,
  protectedActiveProjectProcedure,
} from "../../trpc"
import { formatFeatureCache } from "../../utils/shared"

export const subscriptionRouter = createTRPCRouter({
  create: protectedActiveProjectAdminProcedure
    .input(
      subscriptionInsertSchema.extend({
        items: subscriptionItemsSchema.optional(),
      })
    )
    .output(
      z.object({
        subscription: subscriptionSelectSchema,
      })
    )
    .mutation(async (opts) => {
      const {
        planVersionId,
        customerId,
        items,
        trialDays,
        startDate,
        endDate,
        collectionMethod,
        defaultPaymentMethodId,
        metadata,
      } = opts.input
      const project = opts.ctx.project

      const versionData = await opts.ctx.db.query.versions.findFirst({
        with: {
          planFeatures: {
            with: {
              feature: true,
            },
          },
          plan: true,
        },
        where(fields, operators) {
          return operators.and(
            operators.eq(fields.id, planVersionId),
            operators.eq(fields.projectId, project.id)
          )
        },
      })

      if (!versionData?.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Version not found. Please check the planVersionId and the project",
        })
      }

      if (versionData.status !== "published") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Plan version is not published, only published versions can be subscribed to",
        })
      }

      if (!versionData.planFeatures || versionData.planFeatures.length === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Plan version has no features",
        })
      }

      const customerData = await opts.ctx.db.query.customers.findFirst({
        with: {
          subscriptions: {
            with: {
              features: true,
              planVersion: {
                with: {
                  planFeatures: true,
                },
              },
            },
            where: (sub, { eq }) => eq(sub.status, "active"),
          },
        },
        where: (customer, operators) =>
          operators.and(
            operators.eq(customer.id, customerId),
            operators.eq(customer.projectId, project.id)
          ),
      })

      if (!customerData?.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Customer not found. Please check the customerId",
        })
      }

      // check the active subscriptions of the customer.
      // The plan version the customer is attempting to subscript can't have any feature that the customer already has
      const newFeatures = versionData.planFeatures.map((f) => f.feature.slug)
      const subscriptionFeatureSlugs = customerData.subscriptions.flatMap((sub) =>
        sub.features.map((f) => f.featureSlug)
      )

      const commonFeatures = subscriptionFeatureSlugs.filter((f) => newFeatures.includes(f))

      if (commonFeatures.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `The customer is trying to subscribe to features that are already active in another subscription: ${commonFeatures.join(
            ", "
          )}`,
        })
      }

      let configItemsSubscription: InsertSubscriptionItem[] = []

      if (items) {
        const parseItems = subscriptionItemsSchema.safeParse(items)

        if (!parseItems.success) {
          throw ZodError.create(parseItems.error.errors)
        }

        configItemsSubscription = parseItems.data
      } else {
        // if no items are passed, configuration is created from the default quantities of the plan features
        const { err, val } = createDefaultSubscriptionConfig({
          planVersion: versionData,
        })

        if (err) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: err.message,
          })
        }

        configItemsSubscription = val
      }

      // execute this in a transaction
      const subscriptionData = await opts.ctx.db.transaction(async (trx) => {
        // create the subscription
        const subscriptionId = utils.newId("subscription")

        const newSubscription = await trx
          .insert(schema.subscriptions)
          .values({
            id: subscriptionId,
            projectId: project.id,
            planVersionId: versionData.id,
            customerId: customerData.id,
            startDate: startDate,
            endDate: endDate,
            autoRenew: true,
            trialDays: trialDays,
            isNew: true,
            collectionMethod: collectionMethod,
            status: "active",
            metadata: metadata,
            defaultPaymentMethodId: defaultPaymentMethodId,
          })
          .returning()
          .then((re) => re[0])

        if (!newSubscription) {
          trx.rollback()
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Error while creating subscription",
          })
        }

        // add features to the subscription
        await Promise.all(
          configItemsSubscription.map((item) =>
            trx.insert(schema.subscriptionFeatures).values({
              id: utils.newId("subscription_feature"),
              projectId: newSubscription.projectId,
              subscriptionId: newSubscription.id,
              featurePlanId: item.featurePlanId,
              quantity: item.quantity,
              limit: item.limit,
              min: item.min,
              featureSlug: item.featureSlug,
              usage: item.usage,
            })
          )
        ).catch((e) => {
          console.error(e)
          trx.rollback()
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Error while creating subscription features",
          })
        })

        return newSubscription
      })

      if (!subscriptionData) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error creating subscription",
        })
      }

      // every time a subscription is created, we save the subscription in the cache
      waitUntil(
        opts.ctx.db.query.subscriptions
          .findMany({
            with: {
              features: {
                with: {
                  featurePlan: true,
                },
              },
            },
            where: (sub, { eq, and }) =>
              and(
                eq(sub.customerId, customerData.id),
                eq(sub.projectId, subscriptionData.projectId)
              ),
          })
          .then(async (subscriptions) => {
            if (!subscriptions || subscriptions.length === 0) {
              // TODO: log error
              console.error("Subscriptions not found")
              return
            }

            const customerEntitlements = subscriptions.flatMap((sub) =>
              sub.features.map((f) => f.featureSlug)
            )

            const customerSubscriptions = subscriptions.map((sub) => sub.id)

            return Promise.all([
              // save the customer entitlements
              opts.ctx.cache.entitlementsByCustomerId.set(customerData.id, customerEntitlements),
              // save the customer subscriptions
              opts.ctx.cache.subscriptionsByCustomerId.set(customerData.id, customerSubscriptions),
              // save features
              subscriptions.flatMap((sub) =>
                sub.features.map((f) =>
                  opts.ctx.cache.featureByCustomerId.set(`${sub.customerId}:${f.featureSlug}`, {
                    id: f.id,
                    projectId: f.projectId,
                    featureSlug: f.featureSlug,
                    featurePlanId: f.featurePlanId,
                    subscriptionId: f.subscriptionId,
                    quantity: f.quantity,
                    min: f.min,
                    limit: f.limit,
                    featureType: f.featurePlan.featureType,
                    usage: f.usage,
                  })
                )
              ),
            ])
          })
      )

      return {
        subscription: subscriptionData,
      }
    }),

  listByPlanVersion: protectedActiveProjectProcedure
    .input(
      subscriptionSelectSchema.pick({
        planVersionId: true,
      })
    )
    .output(
      z.object({
        subscriptions: z.array(subscriptionSelectSchema),
      })
    )
    .query(async (opts) => {
      const { planVersionId } = opts.input
      const project = opts.ctx.project

      const subscriptionData = await opts.ctx.db.query.subscriptions.findMany({
        where: (subscription, { eq, and }) =>
          and(
            eq(subscription.projectId, project.id),
            eq(subscription.planVersionId, planVersionId)
          ),
      })

      if (!subscriptionData || subscriptionData.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found. Please check the planVersionId",
        })
      }

      return {
        subscriptions: subscriptionData,
      }
    }),

  remove: protectedActiveProjectAdminProcedure
    .input(
      subscriptionSelectSchema.pick({
        id: true,
        customerId: true,
      })
    )
    .output(z.object({ subscription: subscriptionSelectSchema }))
    .mutation(async (opts) => {
      const { id, customerId } = opts.input
      const project = opts.ctx.project

      const subscriptionData = await opts.ctx.db.query.subscriptions.findFirst({
        where: (subscription, { eq, and }) =>
          and(
            eq(subscription.id, id),
            eq(subscription.projectId, project.id),
            eq(subscription.customerId, customerId)
          ),
        with: {
          features: true,
        },
      })

      if (!subscriptionData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found. Please check the id and customerId",
        })
      }

      if (subscriptionData.status !== "active") {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Subscription is not active, only active subscriptions can be removed. You have to downgrade the subscription to a free plan first",
        })
      }

      // delete the subscription
      const deletedSubscription = await opts.ctx.db
        .delete(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.projectId, subscriptionData.projectId),
            eq(schema.subscriptions.customerId, subscriptionData.customerId),
            eq(schema.subscriptions.id, subscriptionData.id)
          )
        )
        .returning()
        .then((re) => re[0])

      if (!deletedSubscription) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error deleting subscription",
        })
      }

      return {
        subscription: deletedSubscription,
      }
    }),
  end: protectedActiveProjectAdminProcedure
    .input(
      subscriptionSelectSchema.pick({
        id: true,
        customerId: true,
        endDate: true,
      })
    )
    .output(z.object({ subscription: subscriptionSelectSchema }))
    .mutation(async (opts) => {
      const { id, customerId, endDate } = opts.input
      const project = opts.ctx.project

      const subscriptionData = await opts.ctx.db.query.subscriptions.findFirst({
        where: (subscription, { eq, and }) =>
          and(
            eq(subscription.id, id),
            eq(subscription.projectId, project.id),
            eq(subscription.customerId, customerId)
          ),
        with: {
          features: true,
        },
      })

      if (!subscriptionData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Subscription not found. Please check the id and customerId",
        })
      }

      // finish date for the subscription
      const subscription = await opts.ctx.db
        .update(schema.subscriptions)
        .set({
          endDate: endDate ?? new Date(),
        })
        .where(
          and(
            eq(schema.subscriptions.id, id),
            eq(schema.subscriptions.projectId, project.id),
            eq(schema.subscriptions.customerId, customerId)
          )
        )
        .returning()
        .then((re) => re[0])

      if (!subscription) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error ending subscription",
        })
      }

      return {
        subscription,
      }
    }),
})
