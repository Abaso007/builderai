import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import {
  getAnchor,
  planVersionFeatureDragDropSchema,
  planVersionFeatureUpdateBaseSchema,
} from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const update = protectedProjectProcedure
  .input(planVersionFeatureUpdateBaseSchema)
  .output(
    z.object({
      planVersionFeature: planVersionFeatureDragDropSchema,
    })
  )
  .mutation(async (opts) => {
    const hasMeterConfigOverride = Object.prototype.hasOwnProperty.call(opts.input, "meterConfig")
    const {
      id,
      featureId,
      featureType,
      config,
      metadata,
      planVersionId,
      order,
      defaultQuantity,
      limit,
      billingConfig,
      resetConfig,
      type,
      unitOfMeasure,
      meterConfig,
    } = opts.input

    // we purposely don't allow to update the currency and the payment provider
    // those should be update from another method because they are related to the plan version

    const project = opts.ctx.project

    const _workspace = project.workspace

    // only owner and admin can update a feature
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const existingPlanVersionFeature = await opts.ctx.db.query.planVersionFeatures.findFirst({
      with: {
        feature: true,
      },
      where: (planVersionFeature, { and, eq }) =>
        and(eq(planVersionFeature.id, id), eq(planVersionFeature.projectId, project.id)),
    })

    if (!existingPlanVersionFeature?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "feature version not found",
      })
    }

    const planVersionData = await opts.ctx.db.query.versions.findFirst({
      where: (version, { and, eq }) =>
        and(eq(version.id, planVersionId), eq(version.projectId, project.id)),
    })

    if (!planVersionData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version of the plan not found",
      })
    }

    if (planVersionData.status === "published") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Cannot update a feature from a published version",
      })
    }

    // only usage items can have a different billing config but the billing anchor should be the same as the plan version billing config
    const featureTypeUpdate = featureType ?? existingPlanVersionFeature.featureType
    const billingConfigUpdate =
      featureTypeUpdate === "usage" ? billingConfig : planVersionData.billingConfig

    const featureData = existingPlanVersionFeature.feature
    // define the unit of unitOfMeasure
    const unitOfMeasureUpdate =
      unitOfMeasure ?? existingPlanVersionFeature.feature.unitOfMeasure ?? "units"

    const shouldUpdateMeterConfig =
      hasMeterConfigOverride || featureId !== undefined || featureType !== undefined

    const meterConfigUpdate =
      featureTypeUpdate !== "usage"
        ? null
        : hasMeterConfigOverride
          ? (meterConfig ?? null)
          : featureData !== undefined
            ? (featureData.meterConfig ?? null)
            : (existingPlanVersionFeature.meterConfig ?? null)

    if (featureTypeUpdate === "usage" && shouldUpdateMeterConfig && !meterConfigUpdate) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Usage features require meterConfig or a default feature meterConfig",
      })
    }

    if (resetConfig) {
      try {
        getAnchor(Date.now(), resetConfig.resetInterval, resetConfig.resetAnchor)
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid reset configuration: ${error instanceof Error ? error.message : "invalid reset anchor"}`,
        })
      }
    }

    const planVersionFeatureUpdated = await opts.ctx.db
      .update(schema.planVersionFeatures)
      .set({
        ...(planVersionId && { planVersionId }),
        ...(featureId && { featureId }),
        ...(featureType && { featureType }),
        ...(config && { config }),
        ...(metadata && { metadata: { ...planVersionData.metadata, ...metadata } }),
        ...(order && { order }),
        ...(unitOfMeasureUpdate !== undefined && { unitOfMeasure: unitOfMeasureUpdate }),
        ...(defaultQuantity !== undefined && {
          defaultQuantity: defaultQuantity === 0 ? null : defaultQuantity,
        }),
        ...(limit !== undefined && { limit: limit === 0 ? null : limit }),
        ...(shouldUpdateMeterConfig && {
          meterConfig: meterConfigUpdate,
        }),
        ...(billingConfigUpdate && {
          billingConfig: {
            ...billingConfigUpdate,
            billingAnchor: planVersionData.billingConfig.billingAnchor,
          },
        }),
        ...(resetConfig && { resetConfig }),
        ...(type && { type }),
        updatedAtM: Date.now(),
      })
      .where(
        and(
          eq(schema.planVersionFeatures.id, id),
          eq(schema.planVersionFeatures.projectId, project.id)
        )
      )
      .returning()
      .then((re) => re[0])

    if (!planVersionFeatureUpdated) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating version",
      })
    }

    const planVersionFeatureData = await opts.ctx.db.query.planVersionFeatures.findFirst({
      with: {
        planVersion: true,
        feature: true,
      },
      where: (planVersionFeature, { and, eq }) =>
        and(
          eq(planVersionFeature.id, planVersionFeatureUpdated.id),
          eq(planVersionFeature.projectId, project.id)
        ),
    })

    if (!planVersionFeatureData?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error fetching the created feature",
      })
    }

    return {
      planVersionFeature: planVersionFeatureData,
    }
  })
