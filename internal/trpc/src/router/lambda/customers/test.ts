import {
  EntitlementService,
  type EntitlementState,
  MemoryStorageProvider,
} from "@unprice/services/entitlements"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const test = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .mutation(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const entitlementService = new EntitlementService({
      db: opts.ctx.db,
      storage: new MemoryStorageProvider({
        memory: new Map<string, EntitlementState>(),
        logger: opts.ctx.logger,
      }),
      logger: opts.ctx.logger,
      analytics: opts.ctx.analytics,
      waitUntil: opts.ctx.waitUntil,
      cache: opts.ctx.cache,
      metrics: opts.ctx.metrics,
      config: {
        revalidateInterval: 1000 * 60 * 5, // 5 minutes
      },
    })

    const entitlements = await entitlementService.reportUsage({
      customerId,
      projectId: project.id,
      featureSlug: "tokens",
      amount: 1,
    })

    return entitlements
  })
