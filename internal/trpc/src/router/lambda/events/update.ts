import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { eventSelectBaseSchema, eventUpdateBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const update = protectedProjectProcedure
  .input(eventUpdateBaseSchema)
  .output(z.object({ event: eventSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id, name, availableProperties } = opts.input
    const project = opts.ctx.project
    const hasAvailableProperties = Object.prototype.hasOwnProperty.call(
      opts.input,
      "availableProperties"
    )

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId: project.workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.EVENTS.SLUG,
      isMain: project.workspace.isMain,
      action: "update",
      metadata: { module: "event" },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const existingEvent = await opts.ctx.db.query.events.findFirst({
      where: (event, { eq, and }) => and(eq(event.id, id), eq(event.projectId, project.id)),
    })

    if (!existingEvent?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Event not found",
      })
    }

    const event = await opts.ctx.db
      .update(schema.events)
      .set({
        ...(name && { name }),
        ...(hasAvailableProperties && {
          availableProperties: availableProperties?.length ? availableProperties : null,
        }),
        updatedAtM: Date.now(),
      })
      .where(and(eq(schema.events.id, id), eq(schema.events.projectId, project.id)))
      .returning()
      .then((rows) => rows[0])

    if (!event) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating event",
      })
    }

    return { event }
  })
