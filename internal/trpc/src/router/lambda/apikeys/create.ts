import { TRPCError } from "@trpc/server"
import { apikeys } from "@unprice/db/schema"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import { createApiKeySchema, selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(createApiKeySchema)
  .output(
    z.object({
      apikey: selectApiKeySchema.extend({
        key: z.string(),
      }),
    })
  )
  .mutation(async (opts) => {
    const { name, expiresAt } = opts.input
    const project = opts.ctx.project
    const isRoot = project.workspace.isMain

    // only owner and admin
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // Generate the key
    const apiKey = newId("apikey_key")
    // generate the id
    const apiKeyId = newId("apikey")
    // generate hash of the key
    const apiKeyHash = await hashStringSHA256(apiKey)

    const newApiKey = await opts.ctx.db
      .insert(apikeys)
      .values({
        id: apiKeyId,
        name: name,
        hash: apiKeyHash,
        expiresAt: expiresAt,
        projectId: project.id,
        isRoot,
      })
      .returning()
      .then((res) => res[0])
      .catch((err) => {
        opts.ctx.logger.error(err)

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create API key",
        })
      })

    if (!newApiKey) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create API key",
      })
    }

    return { apikey: { ...newApiKey, key: apiKey } }
  })
