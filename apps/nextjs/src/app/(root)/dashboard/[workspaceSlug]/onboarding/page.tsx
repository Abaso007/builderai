import { OnboardingUI } from "~/components/onboarding/onboarding-ui"
import { OnboardingWrapper } from "~/components/onboarding/onboarding-wrapper"
import { StepNavigator } from "~/components/onboarding/step-navigator"

export default function OnboardingPage() {
  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-screen-lg flex-col items-center">
      <OnboardingWrapper>
        <div className="flex h-full w-full flex-col items-center justify-center overflow-x-hidden py-12">
          <OnboardingUI />
        </div>
        <div className="flex h-12 w-full shrink-0 items-center justify-center">
          <StepNavigator />
        </div>
      </OnboardingWrapper>
    </div>
  )
}
