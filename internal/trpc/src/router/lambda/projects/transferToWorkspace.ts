import { TRPCError } from "@trpc/server"
import { eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { projectSelectBaseSchema, transferToWorkspaceSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"
import { projectWorkspaceGuard } from "#utils"

export const transferToWorkspace = protectedWorkspaceProcedure
  .input(transferToWorkspaceSchema)
  .output(
    z.object({
      project: projectSelectBaseSchema.optional(),
      workspaceSlug: z.string().optional(),
    })
  )
  .mutation(async (opts) => {
    const { targetWorkspaceId, projectSlug } = opts.input
    const _workspace = opts.ctx.workspace

    // only owner can transfer a project to a workspace
    opts.ctx.verifyRole(["OWNER"])

    const { project: projectData } = await projectWorkspaceGuard({
      projectSlug,
      ctx: opts.ctx,
    })

    if (projectData.isMain) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot transfer main project",
      })
    }

    if (projectData.workspaceId === targetWorkspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Project is already in the target workspace",
      })
    }

    const targetWorkspace = await opts.ctx.db.query.workspaces.findFirst({
      columns: {
        id: true,
        slug: true,
        unPriceCustomerId: true,
        isMain: true,
      },
      with: {
        projects: true,
      },
      where: (workspace, { eq }) => eq(workspace.id, targetWorkspaceId),
    })

    if (!targetWorkspace?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "target workspace not found",
      })
    }

    const updatedProject = await opts.ctx.db
      .update(schema.projects)
      .set({
        workspaceId: targetWorkspace.id,
      })
      .where(eq(schema.projects.id, projectData.id))
      .returning()
      .then((res) => res[0] ?? undefined)

    return {
      project: updatedProject,
      workspaceSlug: targetWorkspace.slug,
    }
  })
