import type { OnboardingStep } from "@onboardjs/react"
import { ApiKeyStep } from "~/components/onboarding/steps/apikey-step"
import { FinalStep } from "~/components/onboarding/steps/final-step"
import { PaymentProviderStep } from "~/components/onboarding/steps/payment-provider-step"
import { PricingChat } from "~/components/onboarding/steps/pricing-chat-step"
import { ProjectStep } from "~/components/onboarding/steps/project-step"
import { WelcomeStep } from "~/components/onboarding/steps/welcome-step"

// steps.tsx - export your step IDs
export const STEP_IDS = ["welcome", "project", "pricing-chat", "apikey", "done"] as const

export const steps: OnboardingStep[] = [
  {
    id: "welcome",
    component: WelcomeStep,
    nextStep: "project",
  },
  {
    id: "project",
    component: ProjectStep,
    nextStep: "apikey",
  },
  {
    id: "apikey",
    component: ApiKeyStep,
    nextStep: "payment-provider",
  },
  {
    id: "payment-provider",
    component: PaymentProviderStep,
    nextStep: "pricing-chat",
    isSkippable: true,
    skipToStep: "pricing-chat",
  },
  {
    id: "pricing-chat",
    component: PricingChat,
    nextStep: "done",
  },
  {
    id: "done",
    component: FinalStep,
    nextStep: null,
  },
  // {
  //   id: "style-choice",
  //   component: StyleChoice,
  //   nextStep: "command",
  // },
  // {
  //   id: "command",
  //   component: CommandStep,
  //   nextStep: "github",
  // },
  // {
  //   id: "github",
  //   component: GitHubStep,
  //   nextStep: "invite",
  // },
  // {
  //   id: "invite",
  //   component: InviteStep,
  //   nextStep: "subscribe",
  // },
  // {
  //   id: "subscribe",
  //   component: SubscribeStep,
  //   nextStep: null,
  // },
]
