import type { OnboardingStep } from "@onboardjs/react"
import { ApiKeyStep } from "~/components/onboarding/steps/apikey-step"
import { CreateCustomerStep } from "~/components/onboarding/steps/create-customer-step"
import { FinalStep } from "~/components/onboarding/steps/final-step"
import { PaymentProviderStep } from "~/components/onboarding/steps/payment-provider-step"
import { PricingChat } from "~/components/onboarding/steps/pricing-chat-step"
import { ProjectStep } from "~/components/onboarding/steps/project-step"
import { ReportUsageStep } from "~/components/onboarding/steps/report-usage-step"
import { WelcomeStep } from "~/components/onboarding/steps/welcome-step"

// steps.tsx - export your step IDs
export const STEP_IDS = [
  "welcome",
  "project",
  "apikey",
  "payment-provider",
  "pricing-chat",
  "create-customer",
  "report-usage",
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
    nextStep: "create-customer",
    isSkippable: true,
    skipToStep: "create-customer",
  },
  {
    id: "create-customer",
    component: CreateCustomerStep,
    nextStep: "report-usage",
  },
  {
    id: "report-usage",
    component: ReportUsageStep,
    nextStep: "done",
  },
  {
    id: "done",
    component: FinalStep,
    nextStep: null,
  },
]
