"use client"

import { useOnboarding } from "@onboardjs/react"
import { useParams } from "next/navigation"
import { useEffect } from "react"
import { updateContextCookies } from "~/actions/update-context-cookies"
import { useIsOnboarding } from "~/hooks/use-features"
import { FinalStep } from "./steps/final-step"

export function OnboardingUI() {
  const { renderStep, currentStep, state } = useOnboarding()
  const [_, setIsOnboarding] = useIsOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()

  // Sync cookies if the user reloads the page and the project is already created
  useEffect(() => {
    const projectSlug = state?.context?.flowData?.project?.slug
    if (projectSlug && workspaceSlug) {
      void updateContextCookies(workspaceSlug, projectSlug)
    }
  }, [state?.context?.flowData?.project?.slug, workspaceSlug])

  useEffect(() => {
    setIsOnboarding(true)
  }, [])

  if (currentStep === null) {
    return <FinalStep />
  }

  return <>{renderStep()}</>
}
