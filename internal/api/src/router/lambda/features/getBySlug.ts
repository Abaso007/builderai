import { featureSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "../../../trpc"

export const getBySlug = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(z.object({ feature: featureSelectBaseSchema.optional() }))
  .query(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project

    const feature = await opts.ctx.db.query.features.findFirst({
      with: {
        project: {
          columns: {
            slug: true,
          },
        },
      },
      where: (feature, { eq, and }) =>
        and(eq(feature.projectId, project.id), eq(feature.slug, slug)),
    })

    return {
      feature: feature,
    }
  })
