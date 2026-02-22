import { createTRPCRouter } from "#trpc"
import { setOnboardingCompleted } from "./setOnboardingCompleted"

export const authRouter = createTRPCRouter({
  setOnboardingCompleted: setOnboardingCompleted,
})
