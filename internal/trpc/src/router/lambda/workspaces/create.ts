import { TRPCError } from "@trpc/server"
import { and, eq, sql } from "@unprice/db"
import { members } from "@unprice/db/schema"
import { workspaceInsertBase, workspaceSelectBase } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProcedure } from "#trpc"
import { createWorkspace } from "#utils/shared"

export const create = protectedProcedure
  .input(
    workspaceInsertBase.required({
      name: true,
      unPriceCustomerId: true,
    })
  )
  .output(
    z.object({
      workspace: workspaceSelectBase,
    })
  )
  .mutation(async (opts) => {
    const userId = opts.ctx.userId

    let isPersonal = true

    // verify if the user is a member of any workspace
    const countMembers = await opts.ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(members)
      .where(and(eq(members.userId, userId)))
      .then((res) => res[0]?.count ?? 0)

    // if the user is a member of any workspace, the workspace is not personal
    if (countMembers > 0) {
      isPersonal = false
    }
    if (!isPersonal) {
      const _customer = await opts.ctx.db.query.customers.findFirst({
        with: {
          project: {
            with: {
              workspace: true,
            },
          },
        },
        where: (customer, { eq }) => eq(customer.id, opts.input.unPriceCustomerId),
      })
    }

    const newWorkspace = await createWorkspace({
      input: {
        ...opts.input,
        isPersonal,
      },
      db: opts.ctx.db,
      userId: userId,
    })

    if (!newWorkspace) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Workspace not created",
      })
    }

    return {
      workspace: newWorkspace,
    }
  })
