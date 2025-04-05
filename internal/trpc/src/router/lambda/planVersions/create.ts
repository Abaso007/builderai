import { TRPCError } from "@trpc/server"
import { and, eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import * as utils from "@unprice/db/utils"
import { planVersionSelectBaseSchema, versionInsertBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .input(versionInsertBaseSchema)
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const {
      planId,
      metadata,
      description,
      currency,
      billingConfig,
      gracePeriod,
      paymentMethodRequired,
      title,
      tags,
      whenToBill,
      status,
      paymentProvider,
      trialDays,
      autoRenew,
    } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = "plan-versions"

    // only owner and admin can create a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "create",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `You don't have access to this feature ${result.deniedReason}`,
      })
    }

    const planData = await opts.ctx.db.query.plans.findFirst({
      where: (plan, { eq, and }) => and(eq(plan.id, planId), eq(plan.projectId, project.id)),
    })

    if (!planData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "plan not found",
      })
    }

    const planVersionId = utils.newId("plan_version")

    // this should happen in a transaction because we need to change the status of the previous version
    const planVersionData = await opts.ctx.db.transaction(async (tx) => {
      try {
        // get the count of versions for this plan
        const countVersionsPlan = await tx
          .select({ count: sql<number>`count(*)` })
          .from(schema.versions)
          .where(and(eq(schema.versions.projectId, project.id), eq(schema.versions.planId, planId)))
          .then((res) => res[0]?.count ?? 0)

        const planVersionData = await tx
          .insert(schema.versions)
          .values({
            id: planVersionId,
            planId,
            projectId: project.id,
            description,
            title: title,
            tags: tags ?? [],
            status: status ?? "draft",
            paymentProvider,
            currency,
            paymentMethodRequired,
            autoRenew: autoRenew,
            billingConfig,
            trialDays: trialDays,
            gracePeriod: gracePeriod,
            whenToBill: whenToBill,
            metadata,
            version: Number(countVersionsPlan) + 1,
          })
          .returning()
          .catch((err) => {
            opts.ctx.logger.error("There was an issue creating the plan version", {
              error: err.message,
              planVersionId,
            })
            throw err
          })
          .then((re) => re?.[0])

        if (!planVersionData?.id) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "error creating version",
          })
        }

        return planVersionData
      } catch (error) {
        tx.rollback()

        if (error instanceof Error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          })
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "error creating version",
        })
      }
    })

    opts.ctx.waitUntil(
      // report usage for the new project in background
      reportUsageFeature({
        customerId,
        featureSlug,
        usage: 1, // the new project
        isMain: workspace.isMain,
      })
    )

    return {
      planVersion: planVersionData,
    }
  })
