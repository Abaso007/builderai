import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { inviteMembersSchema, invitesSelectBase } from "@unprice/db/validators"
import { WelcomeEmail, sendEmail } from "@unprice/email"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "../../../trpc"

export const inviteMember = protectedWorkspaceProcedure
  .input(inviteMembersSchema)
  .output(
    z.object({
      invite: invitesSelectBase.optional(),
    })
  )
  .mutation(async (opts) => {
    const { email, role } = opts.input
    const workspace = opts.ctx.workspace

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const userByEmail = await opts.ctx.db.query.users.findFirst({
      where: eq(schema.users.email, email),
    })

    if (userByEmail) {
      const member = await opts.ctx.db.query.members.findFirst({
        where: and(
          eq(schema.members.userId, userByEmail.id),
          eq(schema.members.workspaceId, workspace.id)
        ),
      })

      if (member) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "User is already a member of the workspace",
        })
      }
      await opts.ctx.db.insert(schema.members).values({
        userId: userByEmail.id,
        workspaceId: workspace.id,
        role: role,
      })

      return {
        invite: undefined,
      }
    }

    const memberInvited = await opts.ctx.db
      .insert(schema.invites)
      .values({
        email: email,
        workspaceId: workspace.id,
        role: role,
      })
      .returning()
      .then((res) => {
        return res[0]
      })

    await sendEmail({
      from:
        process.env.NODE_ENV === "development"
          ? "delivered@resend.dev"
          : "Sebastian Franco <sebastian@unprice.dev>",
      subject: "Welcome to Unprice 👋",
      to: [email],
      react: WelcomeEmail(),
    })

    return {
      invite: memberInvited,
    }
  })