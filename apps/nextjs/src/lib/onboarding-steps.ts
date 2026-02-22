import type { OnboardingStep } from "@onboardjs/react"
import { FinalStep } from "~/components/onboarding/steps/final-step"
import { PaymentProviderStep } from "~/components/onboarding/steps/payment-provider-step"
import { ProjectStep } from "~/components/onboarding/steps/project-step"
import { SeedMetricsStep } from "~/components/onboarding/steps/seed-metrics-step"
import { TemplatePlanStep } from "~/components/onboarding/steps/template-plan-step"
import { WelcomeStep } from "~/components/onboarding/steps/welcome-step"

// steps.tsx - export your step IDs
export const STEP_IDS = [
  "welcome",
  "project",
  "payment-provider",
  "template-plan",
  "seed-metrics",
  "done",
] as const

export const steps: OnboardingStep[] = [
  {
    id: "welcome",
    component: WelcomeStep,
    nextStep: "project",
  },
  {
    id: "project",
    component: ProjectStep,
    nextStep: "payment-provider",
  },
  {
    id: "payment-provider",
    component: PaymentProviderStep,
    nextStep: "template-plan",
  },
  {
    id: "template-plan",
    component: TemplatePlanStep,
    nextStep: "seed-metrics",
  },
  {
    id: "seed-metrics",
    component: SeedMetricsStep,
    nextStep: "done",
  },
  {
    id: "done",
    component: FinalStep,
    nextStep: null,
  },
]
