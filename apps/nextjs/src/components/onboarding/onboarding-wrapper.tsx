"use client"
import { OnboardingProvider } from "@onboardjs/react"
import { useMutation } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { steps } from "~/lib/onboarding-steps"
import { useTRPC } from "~/trpc/client"

export function OnboardingWrapper({ children }: PropsWithChildren) {
  // const isDev = process.env.NODE_ENV === "development"
  const trpc = useTRPC()

  const mutateSetOnboardingCompleted = useMutation(
    trpc.auth.setOnboardingCompleted.mutationOptions({
      onSuccess: () => {
        console.info("Onboarding complete")
      },
    })
  )

  return (
    <OnboardingProvider
      steps={steps}
      onFlowComplete={() => {
        mutateSetOnboardingCompleted.mutate({ onboardingCompleted: true })
      }}
      debug={false}
      localStoragePersistence={{
        key: "unprice_onboarding_v1",
        ttl: 1000 * 60 * 60 * 24 * 30, // 30 days
      }}

      // localStoragePersistence={
      //   isDev
      //     ? undefined
      //     : {
      //         key: "unprice_onboarding_v1",
      //         ttl: 1000 * 60 * 60 * 24 * 30, // 30 days
      //       }
      // }
    >
      {children}
    </OnboardingProvider>
  )
}
