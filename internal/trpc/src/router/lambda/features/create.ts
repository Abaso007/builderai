import { TRPCError } from "@trpc/server"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { featureInsertBaseSchema, featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(featureInsertBaseSchema)
  .output(z.object({ feature: featureSelectBaseSchema }))
  .mutation(async (opts) => {
    const { description, slug, title, unitOfMeasure, meterConfig } = opts.input
    const project = opts.ctx.project

    const featureId = newId("feature")
    const featureData = await opts.ctx.db
      .insert(schema.features)
      .values({
        id: featureId,
        slug,
        title,
        projectId: project.id,
        description,
        unitOfMeasure,
        meterConfig: meterConfig ?? null,
      })
      .returning()
      .then((data) => data[0])

    if (!featureData) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating feature",
      })
    }

    return {
      feature: featureData,
    }
  })
