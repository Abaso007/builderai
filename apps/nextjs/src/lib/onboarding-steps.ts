import type { OnboardingStep } from "@onboardjs/react"
import { ProjectStep } from "~/components/onboarding/steps/project-step"
import { WelcomeStep } from "~/components/onboarding/steps/welcome-step"

// steps.tsx - export your step IDs
export const STEP_IDS = ["welcome", "project"] as const

export const steps: OnboardingStep[] = [
  {
    id: "welcome",
    component: WelcomeStep,
    // nextStep: "style-choice",
    nextStep: "project",
  },
  {
    id: "project",
    component: ProjectStep,
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
