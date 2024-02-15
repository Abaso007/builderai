import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { eq, schema } from "@builderai/db"
import { selectWorkspaceSchema } from "@builderai/validators/workspace"

import {
  createTRPCRouter,
  protectedWorkspaceOwnerProcedure,
  protectedWorkspaceProcedure,
} from "../../trpc"

// this router controls organizations from Clerk.
// Workspaces are similar to organizations in Clerk
// We sync the two to keep the data consistent (see @builderai/auth webhooks)
export const workspaceRouter = createTRPCRouter({
  getBySlug: protectedWorkspaceProcedure
    .input(z.object({ workspaceSlug: z.string() }))
    .output(selectWorkspaceSchema)
    .query(async (opts) => {
      const { workspaceSlug } = opts.input

      const workspace = await opts.ctx.db.query.workspaces.findFirst({
        where: (workspace, operators) =>
          operators.eq(workspace.slug, workspaceSlug),
      })

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        })
      }

      return workspace
    }),

  delete: protectedWorkspaceOwnerProcedure
    .input(z.object({ workspaceSlug: z.string() }))
    .output(z.object({ workspace: selectWorkspaceSchema.optional() }))
    .mutation(async (opts) => {
      const { workspaceSlug } = opts.input
      const userId = opts.ctx.session?.user?.id

      if (!userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "userId not provided, logout and login again",
        })
      }

      const workspace = await opts.ctx.db.query.workspaces.findFirst({
        where: (workspace, operators) =>
          operators.eq(workspace.slug, workspaceSlug),
      })

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        })
      }

      if (workspace?.isPersonal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Cannot delete personal workspace. Contact support to delete your account.",
        })
      }

      const deletedWorkspace = await opts.ctx.db
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.id, workspace.id))
        .returning()

      if (!deletedWorkspace?.[0]) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error deleting workspace",
        })
      }

      return {
        workspace: deletedWorkspace[0],
      }
    }),
  listWorkspaces: protectedWorkspaceProcedure
    .input(z.void())
    .output(
      z.object({
        workspaces: z.array(
          selectWorkspaceSchema
            .pick({
              id: true,
              name: true,
              slug: true,
              imageUrl: true,
              isPersonal: true,
            })
            .extend({
              role: z.string(),
              userId: z.string(),
            })
        ),
      })
    )
    .query(async (opts) => {
      const userId = opts.ctx.session?.user?.id

      if (!userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "userId not provided, logout and login again",
        })
      }

      const memberships = await opts.ctx.db.query.members.findMany({
        with: {
          workspace: {
            columns: {
              id: true,
              name: true,
              slug: true,
              imageUrl: true,
              isPersonal: true,
            },
          },
        },
        where: (members, operators) => operators.eq(members.userId, userId),
        orderBy: (members) => members.createdAt,
      })

      const workspaces = memberships.map((member) => ({
        ...member.workspace,
        role: member.role,
        userId: member.userId,
      }))

      return {
        workspaces: workspaces,
      }
    }),
  // listMembers: protectedWorkspaceProcedure.query(async (opts) => {
  //   const { orgId } = opts.ctx.auth

  //   if (!orgId) {
  //     throw new TRPCError({
  //       code: "BAD_REQUEST",
  //       message: "orgId not provided, logout and login again",
  //     })
  //   }

  //   const members =
  //     await clerkClient.organizations.getOrganizationMembershipList({
  //       organizationId: orgId,
  //     })

  //   return members.map((member) => ({
  //     id: member.id,
  //     email: member.publicUserData?.identifier ?? "",
  //     role: member.role,
  //     joinedAt: member.createdAt,
  //     avatarUrl: member.publicUserData?.imageUrl,
  //     name: [
  //       member.publicUserData?.firstName,
  //       member.publicUserData?.lastName,
  //     ].join(" "),
  //   }))
  // }),

  // deleteMember: protectedWorkspaceAdminProcedure
  //   .input(z.object({ userId: z.string() }))
  //   .output(z.object({ memberName: z.string().optional().nullable() }))
  //   .mutation(async (opts) => {
  //     const { orgId } = opts.ctx.auth

  //     if (!orgId) {
  //       throw new TRPCError({
  //         code: "BAD_REQUEST",
  //         message: "orgId not provided, logout and login again",
  //       })
  //     }

  //     try {
  //       const member =
  //         await clerkClient.organizations.deleteOrganizationMembership({
  //           organizationId: orgId,
  //           userId: opts.input.userId,
  //         })

  //       return { memberName: member.publicUserData?.firstName }
  //     } catch (e) {
  //       console.error("Error deleting member", e)
  //       throw new TRPCError({
  //         code: "NOT_FOUND",
  //         message: "User not found",
  //       })
  //     }
  //   }),

  // inviteMember: protectedWorkspaceAdminProcedure
  //   .input(inviteOrgMemberSchema)
  //   .mutation(async (opts) => {
  //     const { orgId } = opts.ctx.auth

  //     const { email } = opts.input
  //     const users = await clerkClient.users.getUserList({
  //       emailAddress: [email],
  //     })
  //     const user = users[0]

  //     if (users.length === 0 || !user) {
  //       throw new TRPCError({
  //         code: "NOT_FOUND",
  //         message: "User not found",
  //       })
  //     }

  //     if (users.length > 1) {
  //       throw new TRPCError({
  //         code: "BAD_REQUEST",
  //         message: "Multiple users found with that email address",
  //       })
  //     }

  //     if (!orgId) {
  //       throw new TRPCError({
  //         code: "BAD_REQUEST",
  //         message: "orgId not provided",
  //       })
  //     }

  //     const member =
  //       await clerkClient.organizations.createOrganizationMembership({
  //         organizationId: orgId,
  //         userId: user.id,
  //         role: opts.input.role,
  //       })

  //     const { firstName, lastName } = member.publicUserData ?? {}
  //     return { name: [firstName, lastName].join(" ") }
  //   }),

  // deleteOrganization: protectedWorkspaceAdminProcedure.mutation(async (opts) => {
  //   const { orgId } = opts.ctx.auth

  //   if (!orgId) {
  //     throw new TRPCError({
  //       code: "BAD_REQUEST",
  //       message: "orgId not provided",
  //     })
  //   }

  //   await clerkClient.organizations.deleteOrganization(orgId)
  // }),
})
