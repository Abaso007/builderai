import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { eq } from "@unprice/db"
import { projects } from "@unprice/db/schema"
import { protectedProjectProcedure } from "#trpc"

export const migrate = protectedProjectProcedure
  .input(z.void())
  .output(
    z.object({
      success: z.boolean(),
      message: z.string(),
    })
  )
  .mutation(async (opts) => {
    const project_id = opts.ctx.project.id
    const isMain = opts.ctx.project.workspace.isMain
    const isInternal = opts.ctx.project.workspace.isInternal

    if (!isMain && !isInternal) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Only main or internal projects can be migrated to analytics",
      })
    }

    const project = await opts.ctx.db.query.projects.findFirst({
      where: (fields, operators) => operators.eq(fields.id, project_id),
    })

    if (!project) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Project not found",
      })
    }

    // if the analytics data is already up to date, return
    if (project.metadata?.analyticsUpdatedAt) {
      return { success: true, message: "Analytics data is already up to date" }
    }

    // only owner can migrate
    opts.ctx.verifyRole(["OWNER"])

    try {
      // update the project metadata
      await opts.ctx.db
        .update(projects)
        .set({
          metadata: {
            analyticsUpdatedAt: Date.now(),
          },
        })
        .where(eq(projects.id, project_id))

      return { success: true, message: "Analytics data migrated successfully" }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"
      opts.ctx.logger.error(errorMessage)

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: errorMessage,
      })
    }
  })
