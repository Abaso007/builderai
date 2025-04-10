import { TRPCError } from "@trpc/server"
import { apikeys } from "@unprice/db/schema"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import { createApiKeySchema, selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .input(createApiKeySchema)
  .output(
    z.object({
      apikey: selectApiKeySchema,
    })
  )
  .mutation(async (opts) => {
    const { name, expiresAt } = opts.input
    const project = opts.ctx.project
    const customerId = project.workspace.unPriceCustomerId
    const featureSlug = "apikeys"

    // only owner and admin
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId,
      featureSlug,
      ctx: opts.ctx,
      skipCache: true,
      updateUsage: true,
      isInternal: project.workspace.isInternal,
      metadata: {
        action: "create",
      },
    })

    if (!result.access) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `You don't have access to this feature ${result.deniedReason}`,
      })
    }

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
        key: apiKey,
        hash: apiKeyHash,
        expiresAt: expiresAt,
        projectId: project.id,
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

    opts.ctx.waitUntil(
      // report usage for the new project in background
      reportUsageFeature({
        customerId,
        featureSlug,
        usage: 1, // the new project
        ctx: opts.ctx,
        isInternal: project.workspace.isInternal,
      })
    )

    return { apikey: newApiKey }
  })
