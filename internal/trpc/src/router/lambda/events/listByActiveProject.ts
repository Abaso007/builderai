import { eventSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const listByActiveProject = protectedProjectProcedure
  .input(z.void())
  .output(z.object({ events: z.array(eventSelectBaseSchema) }))
  .query(async (opts) => {
    const project = opts.ctx.project

    const events = await opts.ctx.db.query.events.findMany({
      where: (event, { eq }) => eq(event.projectId, project.id),
      orderBy: (event, { asc, desc }) => [asc(event.name), desc(event.updatedAtM)],
    })

    return {
      events,
    }
  })
