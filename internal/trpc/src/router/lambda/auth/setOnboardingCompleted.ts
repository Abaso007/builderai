import { eq } from "@unprice/db"
import { users } from "@unprice/db/schema"
import { z } from "zod"
import { protectedProcedure } from "#trpc"

export const setOnboardingCompleted = protectedProcedure
  .input(z.object({ onboardingCompleted: z.boolean() }))
  .output(z.object({ success: z.boolean() }))
  .mutation(async (opts) => {
    const { onboardingCompleted } = opts.input
    const userId = opts.ctx.userId

    await opts.ctx.db
      .update(users)
      .set({ onboardingCompleted, onboardingCompletedAt: new Date() })
      .where(eq(users.id, userId))

    return {
      success: true,
    }
  })
