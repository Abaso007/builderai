import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import * as utils from "@unprice/db/utils"
import {
  projectInsertBaseSchema,
  projectSelectBaseSchema,
  renameProjectSchema,
  transferToPersonalProjectSchema,
  transferToWorkspaceSchema,
  workspaceSelectBase,
} from "@unprice/db/validators"

import {
  createTRPCRouter,
  protectedProcedure,
  protectedProjectProcedure,
  protectedWorkspaceProcedure,
} from "../../trpc"
import { projectWorkspaceGuard } from "../../utils"
import { getRandomPatternStyle } from "../../utils/generate-pattern"
import { workspaceGuard } from "../../utils/workspace-guard"

// TODO: Don't hardcode the limit to PRO
const PROJECT_LIMITS = {
  FREE: 1,
  PRO: 3,
} as const

export const projectRouter = createTRPCRouter({
  create: protectedWorkspaceProcedure
    .input(projectInsertBaseSchema)
    .output(
      z.object({
        project: projectSelectBaseSchema,
      })
    )
    .mutation(async (opts) => {
      const { name, url } = opts.input
      const workspace = opts.ctx.workspace

      const countProjectsWorkspace = await opts.ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.projects)
        .where(eq(schema.projects.workspaceId, workspace.id))
        .then((res) => res[0]?.count ?? 0)

      // TODO: Don't hardcode the limit to PRO
      if (countProjectsWorkspace >= PROJECT_LIMITS.PRO) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Limit reached" })
      }

      // TODO: should be able to retry if the slug already exists
      const projectId = utils.newId("project")
      const projectSlug = utils.createSlug()

      const newProject = await opts.ctx.db
        .insert(schema.projects)
        .values({
          id: projectId,
          workspaceId: workspace.id,
          name,
          slug: projectSlug,
          url,
          // TODO: pass this from the client
          defaultCurrency: "USD",
          timezone: "UTC",
          isMain: false,
          isInternal: false,
        })
        .returning()
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
    }),

  rename: protectedProjectProcedure
    .input(renameProjectSchema)
    .output(
      z.object({
        project: projectSelectBaseSchema.optional(),
      })
    )
    .mutation(async (opts) => {
      const { name } = opts.input
      const project = opts.ctx.project

      // only owner and admin can rename a project
      opts.ctx.verifyRole(["OWNER", "ADMIN"])

      const projectRenamed = await opts.ctx.db
        .update(schema.projects)
        .set({
          name,
        })
        .where(eq(schema.projects.id, project.id))
        .returning()
        .then((res) => res[0] ?? undefined)

      return {
        project: projectRenamed,
      }
    }),

  delete: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string().optional(),
        projectSlug: z.string().optional(),
      })
    )
    .output(
      z.object({
        project: projectSelectBaseSchema,
      })
    )
    .mutation(async (opts) => {
      const project = opts.ctx.project

      // only owner and admin can delete a project
      opts.ctx.verifyRole(["OWNER", "ADMIN"])

      const deletedProject = await opts.ctx.db
        .delete(schema.projects)
        .where(eq(schema.projects.id, project.id))
        .returning()
        .then((res) => res[0] ?? undefined)

      if (!deletedProject?.id) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error deleting project",
        })
      }

      return {
        project: deletedProject,
      }
    }),
  transferToPersonal: protectedWorkspaceProcedure
    .input(transferToPersonalProjectSchema)
    .output(
      z.object({
        project: projectSelectBaseSchema.optional(),
        workspaceSlug: z.string().optional(),
      })
    )
    .mutation(async (opts) => {
      const { slug: projectSlug } = opts.input
      const userId = opts.ctx.userId

      const { project: projectData } = await projectWorkspaceGuard({
        projectSlug,
        ctx: opts.ctx,
      })

      if (projectData.workspace.isPersonal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project is already in the personal workspace",
        })
      }

      const personalTargetWorkspace = await opts.ctx.db.query.workspaces.findFirst({
        columns: {
          id: true,
          slug: true,
        },
        where: (workspace, { eq, and }) =>
          and(eq(workspace.createdBy, userId), eq(workspace.isPersonal, true)),
      })

      if (!personalTargetWorkspace?.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "There is no personal workspace for the user",
        })
      }

      // TODO: do not hard code the limit - is it possible to reduce the queries?
      const projectsCount = await opts.ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.projects)
        .where(eq(schema.projects.workspaceId, personalTargetWorkspace.id))
        .then((res) => res[0]?.count ?? 0)

      // TODO: Don't hardcode the limit to PRO - the user is paying, should it be possible to transfer projects?
      if (projectsCount >= PROJECT_LIMITS.PRO) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The target workspace reached its limit of projects",
        })
      }

      // change the workspace for the project to personalTargetWorkspace
      const updatedProject = await opts.ctx.db
        .update(schema.projects)
        .set({
          workspaceId: personalTargetWorkspace.id,
        })
        .where(eq(schema.projects.id, projectData.id))
        .returning()
        .then((res) => res[0] ?? undefined)

      return {
        project: updatedProject,
        workspaceSlug: personalTargetWorkspace.slug,
      }
    }),

  // TODO: all this again
  transferToWorkspace: protectedWorkspaceProcedure
    .input(transferToWorkspaceSchema)
    .output(
      z.object({
        project: projectSelectBaseSchema.optional(),
        workspaceSlug: z.string().optional(),
      })
    )
    .mutation(async (opts) => {
      const { targetWorkspaceId, projectSlug } = opts.input

      const { project: projectData } = await projectWorkspaceGuard({
        projectSlug,
        ctx: opts.ctx,
      })

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

      // TODO: Don't hardcode the limit to PRO - the user is paying, should it be possible to transfer projects?
      if (targetWorkspace.projects.length >= PROJECT_LIMITS.PRO) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The target workspace reached its limit of projects",
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
    }),

  listByActiveWorkspace: protectedWorkspaceProcedure
    .input(z.void())
    .output(
      z.object({
        projects: z.array(
          projectSelectBaseSchema.extend({
            styles: z.object({
              backgroundImage: z.string(),
            }),
            workspace: workspaceSelectBase.pick({
              slug: true,
            }),
          })
        ),
        limit: z.number(),
        limitReached: z.boolean(),
      })
    )
    .query(async (opts) => {
      const activeWorkspaceId = opts.ctx.workspace.id

      const workspaceProjects = await opts.ctx.db.query.workspaces.findFirst({
        with: {
          projects: {
            orderBy: (project, { desc }) => [desc(project.createdAtM)],
          },
        },
        where: (workspace, { eq }) => eq(workspace.id, activeWorkspaceId),
      })

      if (!workspaceProjects) {
        return {
          projects: [],
          limit: PROJECT_LIMITS.PRO,
          limitReached: false,
        }
      }

      const { projects, ...rest } = workspaceProjects

      // TODO: Don't hardcode the limit to PRO
      return {
        projects: projects.map((project) => ({
          ...project,
          workspace: rest,
          styles: getRandomPatternStyle(project.id),
        })),
        limit: PROJECT_LIMITS.PRO,
        limitReached: projects.length >= PROJECT_LIMITS.PRO,
      }
    }),
  listByWorkspace: protectedProcedure
    .input(z.object({ workspaceSlug: z.string() }))
    .output(
      z.object({
        projects: z.array(
          projectSelectBaseSchema.extend({
            styles: z.object({
              backgroundImage: z.string(),
            }),
            workspace: workspaceSelectBase.pick({
              slug: true,
              plan: true,
            }),
          })
        ),
        limit: z.number(),
        limitReached: z.boolean(),
      })
    )
    .query(async (opts) => {
      const { workspaceSlug } = opts.input

      const { workspace: workspaceData } = await workspaceGuard({
        workspaceSlug: workspaceSlug,
        ctx: opts.ctx,
      })

      const workspaceProjects = await opts.ctx.db.query.workspaces.findFirst({
        with: {
          projects: {
            orderBy: (project, { desc }) => [desc(project.createdAtM)],
          },
        },
        where: (workspace, { eq }) => eq(workspace.id, workspaceData.id),
      })

      if (!workspaceProjects) {
        return {
          projects: [],
          limit: PROJECT_LIMITS.PRO,
          limitReached: false,
        }
      }

      const { projects, ...rest } = workspaceProjects

      // TODO: Don't hardcode the limit to PRO
      return {
        projects: projects.map((project) => ({
          ...project,
          workspace: rest,
          styles: getRandomPatternStyle(project.id),
        })),
        limit: PROJECT_LIMITS.PRO,
        limitReached: projects.length >= PROJECT_LIMITS.PRO,
      }
    }),
  getBySlug: protectedWorkspaceProcedure
    .input(z.object({ slug: z.string() }))
    .output(
      z.object({
        project: projectSelectBaseSchema.extend({
          workspace: workspaceSelectBase,
        }),
      })
    )
    .query(async (opts) => {
      const workspace = opts.ctx.workspace

      const projectData = await opts.ctx.db.query.projects.findFirst({
        with: {
          workspace: true,
        },
        where: (project, { eq, and }) =>
          and(eq(project.slug, opts.input.slug), eq(project.workspaceId, workspace.id)),
      })

      if (!projectData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        })
      }

      return {
        project: projectData,
      }
    }),
  getById: protectedWorkspaceProcedure
    .input(z.object({ id: z.string() }))
    .output(
      z.object({
        project: projectSelectBaseSchema.extend({
          workspace: workspaceSelectBase,
        }),
      })
    )
    .query(async (opts) => {
      const workspace = opts.ctx.workspace

      const projectData = await opts.ctx.db.query.projects.findFirst({
        with: {
          workspace: true,
        },
        where: (project, { eq, and }) =>
          and(eq(project.slug, opts.input.id), eq(project.workspaceId, workspace.id)),
      })

      if (!projectData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        })
      }

      return {
        project: projectData,
      }
    }),
})
