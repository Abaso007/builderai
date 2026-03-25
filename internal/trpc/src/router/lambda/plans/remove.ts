import { TRPCError } from "@trpc/server"
import { and, eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { planSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const remove = protectedProjectProcedure
  .input(planSelectBaseSchema.pick({ id: true }))
  .output(z.object({ plan: planSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const _workspace = opts.ctx.project.workspace
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const countVersionsPlan = await opts.ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.projectId, project.id),
          eq(schema.versions.planId, id),
          eq(schema.versions.status, "published")
        )
      )
      .then((res) => res[0]?.count ?? 0)

    if (countVersionsPlan > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "You cannot delete a plan that has published versions. Please deactivate it instead",
      })
    }

    const deletedPlan = await opts.ctx.db
      .delete(schema.plans)
      .where(and(eq(schema.plans.projectId, project.id), eq(schema.plans.id, id)))
      .returning()
      .then((data) => data[0])

    if (!deletedPlan) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting plan",
      })
    }

    return {
      plan: deletedPlan,
    }
  })
