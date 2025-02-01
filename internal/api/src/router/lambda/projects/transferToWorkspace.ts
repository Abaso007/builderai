import { TRPCError } from "@trpc/server"
import { eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { projectSelectBaseSchema, transferToWorkspaceSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedWorkspaceProcedure } from "#/trpc"
import { projectWorkspaceGuard } from "#/utils"
import { featureGuard } from "#/utils/feature-guard"

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
    const workspace = opts.ctx.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = "projects"

    // only owner can transfer a project to a workspace
    opts.ctx.verifyRole(["OWNER"])

    // check if the customer has access to the feature
    await featureGuard({
      customerId,
      featureSlug,
      ctx: opts.ctx,
      skipCache: true,
      isInternal: workspace.isInternal,
    })

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
        isInternal: true,
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

    // check if the customer of the target workspace has access to the feature
    try {
      await featureGuard({
        customerId: targetWorkspace.unPriceCustomerId,
        featureSlug,
        ctx: opts.ctx,
        skipCache: true,
        isInternal: targetWorkspace.isInternal,
      })
    } catch (error) {
      const e = error as TRPCError
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `The target workspace has no access to the feature: ${e.message}`,
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
