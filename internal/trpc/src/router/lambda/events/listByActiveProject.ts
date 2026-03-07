import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import { eventSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const listByActiveProject = protectedProjectProcedure
  .input(z.void())
  .output(z.object({ events: z.array(eventSelectBaseSchema) }))
  .query(async (opts) => {
    const project = opts.ctx.project

    const result = await featureGuard({
      customerId: project.workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.EVENTS.SLUG,
      isMain: project.workspace.isMain,
      action: "listByActiveProject",
      metadata: { module: "event" },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const events = await opts.ctx.db.query.events.findMany({
      where: (event, { eq }) => eq(event.projectId, project.id),
      orderBy: (event, { asc, desc }) => [asc(event.name), desc(event.updatedAtM)],
    })

    return {
      events,
    }
  })
