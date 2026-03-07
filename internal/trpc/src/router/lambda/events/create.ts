import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { eventInsertBaseSchema, eventSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const create = protectedProjectProcedure
  .input(eventInsertBaseSchema)
  .output(z.object({ event: eventSelectBaseSchema }))
  .mutation(async (opts) => {
    const { name, slug, availableProperties } = opts.input
    const project = opts.ctx.project

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId: project.workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.EVENTS.SLUG,
      isMain: project.workspace.isMain,
      action: "create",
      metadata: { module: "event" },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const event = await opts.ctx.db
      .insert(schema.events)
      .values({
        id: newId("event"),
        projectId: project.id,
        name,
        slug,
        availableProperties: availableProperties?.length ? availableProperties : null,
      })
      .returning()
      .then((rows) => rows[0])

    if (!event) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating event",
      })
    }

    return { event }
  })
