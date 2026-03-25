import { TRPCError } from "@trpc/server"
import { sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

// TODO: move this to apikey service
export const revoke = protectedProjectProcedure
  .input(z.object({ ids: z.string().array() }))
  .output(z.object({ success: z.boolean(), numRevoked: z.number() }))
  .mutation(async (opts) => {
    const { ids } = opts.input
    const project = opts.ctx.project

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const data = await opts.ctx.db
      .update(schema.apikeys)
      .set({ revokedAt: Date.now(), updatedAtM: Date.now() })
      .where(
        sql`${schema.apikeys.id} in ${ids} AND ${schema.apikeys.projectId} = ${project.id} AND ${schema.apikeys.revokedAt} is NULL`
      )
      .returning()

    if (data.length === 0) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "API key not found or already revoked",
      })
    }

    // remove from cache
    opts.ctx.waitUntil(
      Promise.all([...data.map(async (apikey) => opts.ctx.cache.apiKeyByHash.remove(apikey.hash))])
    )

    return { success: true, numRevoked: data.length }
  })
