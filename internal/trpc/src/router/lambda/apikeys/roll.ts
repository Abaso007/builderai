import { TRPCError } from "@trpc/server"
import { selectApiKeySchema } from "@unprice/db/validators"
import { ApiKeysService } from "@unprice/services/apikey"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const roll = protectedProjectProcedure
  .input(z.object({ hashKey: z.string() }))
  .output(
    z.object({
      apikey: selectApiKeySchema.extend({
        key: z.string(),
      }),
    })
  )
  .mutation(async (opts) => {
    const { hashKey } = opts.input
    const _project = opts.ctx.project

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const apikeyService = new ApiKeysService({
      cache: opts.ctx.cache,
      metrics: opts.ctx.metrics,
      analytics: opts.ctx.analytics,
      logger: opts.ctx.logger,
      db: opts.ctx.db,
      waitUntil: opts.ctx.waitUntil,
      hashCache: opts.ctx.hashCache,
    })

    const { val: newApiKey, err: newApiKeyErr } = await apikeyService.rollApiKey({
      keyHash: hashKey,
    })

    if (newApiKeyErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: newApiKeyErr.message,
      })
    }

    return { apikey: { ...newApiKey, key: newApiKey.newKey } }
  })
