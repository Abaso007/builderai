import { TRPCError } from "@trpc/server"
import { projects } from "@unprice/db/schema"
import { createSlug, newId } from "@unprice/db/utils"
import { projectInsertBaseSchema, projectSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const create = protectedWorkspaceProcedure
  .input(projectInsertBaseSchema)
  .output(z.object({ project: projectSelectBaseSchema }))
  .mutation(async (opts) => {
    const { name, url, defaultCurrency, timezone, contactEmail } = opts.input
    const workspace = opts.ctx.workspace
    const defaultContactEmail = opts.ctx.session.user.email

    // only owner and admin can create a project
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const projectId = newId("project")
    const projectSlug = createSlug()

    const newProject = await opts.ctx.db
      .insert(projects)
      .values({
        id: projectId,
        workspaceId: workspace.id,
        name,
        slug: projectSlug,
        url,
        defaultCurrency,
        timezone,
        isMain: false,
        isInternal: workspace.isInternal,
        contactEmail: contactEmail || defaultContactEmail,
      })
      .returning()
      .catch((err) => {
        opts.ctx.logger.error(err)

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create project",
        })
      })
      .then((res) => res[0] ?? null)

    if (!newProject?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating project",
      })
    }

    return {
      project: newProject,
    }
  })
