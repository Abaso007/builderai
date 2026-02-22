"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { cn } from "@unprice/ui/utils"

export function StepNavigator() {
  const isDev = process.env.NODE_ENV === "development"
  const { state, goToStep, engine } = useOnboarding()
  const steps = state?.totalSteps ?? 0

  return (
    <div className="flex items-center justify-center">
      {Array.from({ length: steps }).map((_, index) => {
        const isCurrentStep = state?.currentStepNumber === index + 1
        const currentStep = engine?.getRelevantSteps()[index]

        if (!currentStep) {
          return null
        }

        return (
          <Button
            size="icon"
            variant="link"
            key={currentStep.id}
            // do not disable the button if in development
            disabled={!isDev && index + 1 >= (state?.currentStepNumber ?? 0)}
            onClick={() => goToStep(String(currentStep.id))}
          >
            <div
              className={cn("mx-2.5 my-2.5 size-2 rounded-full transition-colors", {
                "bg-primary-solidHover": isCurrentStep,
                "bg-background-line": !isCurrentStep,
              })}
            />
          </Button>
        )
      })}
    </div>
  )
}
