"use client"
import { OnboardingProvider } from "@onboardjs/react"
import type { PropsWithChildren } from "react"
import { steps } from "~/lib/onboarding-steps"

export function OnboardingWrapper({ children }: PropsWithChildren) {
  const isDev = process.env.NODE_ENV === "development"

  return (
    <OnboardingProvider
      steps={steps}
      onFlowComplete={(ctx) => {
        console.info("Onboarding complete", ctx)
        // TODO: set onboarding complete flag in the database
      }}
      debug={false}
      localStoragePersistence={
        isDev
          ? undefined
          : {
              key: "unprice_onboarding_v1",
              ttl: 1000 * 60 * 60 * 24, // 1 day
            }
      }
    >
      {children}
    </OnboardingProvider>
  )
}
