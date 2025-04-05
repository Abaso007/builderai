import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const exist = protectedProjectProcedure
  .input(z.object({ slug: z.string(), id: z.string().optional() }))
  .output(
    z.object({
      exist: z.boolean(),
    })
  )
  .mutation(async (opts) => {
    const { slug, id } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = "plans"

    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
      metadata: {
        action: "exist",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `You don't have access to this feature ${result.deniedReason}`,
      })
    }

    const plan = await opts.ctx.db.query.plans.findFirst({
      columns: {
        id: true,
      },
      where: (plan, { eq, and }) =>
        id
          ? and(eq(plan.projectId, project.id), eq(plan.id, id))
          : and(eq(plan.projectId, project.id), eq(plan.slug, slug)),
    })

    return {
      exist: !!plan,
    }
  })
