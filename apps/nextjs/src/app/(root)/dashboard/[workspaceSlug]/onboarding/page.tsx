// import { Onboarding } from "./_components/multi-step-form"

import { OnboardingUI } from "~/components/onboarding/onboarding-ui"
import { OnboardingWrapper } from "~/components/onboarding/onboarding-wrapper"
import { StepNavigator } from "~/components/onboarding/step-navigator"

export default function OnboardingPage() {
  return (
    <OnboardingWrapper>
      <div className="flex min-h-[540px] flex-[1_1_auto] shrink-0 flex-col items-center justify-center overflow-x-hidden py-12">
        <OnboardingUI />
      </div>
      <div className="flex h-12 w-full shrink-0 items-center justify-center">
        <StepNavigator />
      </div>
    </OnboardingWrapper>
  )
}
