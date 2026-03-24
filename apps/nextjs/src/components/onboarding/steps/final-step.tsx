"use client"

import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { useParams, useRouter } from "next/navigation"

export function FinalStep({ className }: React.ComponentProps<"div">) {
  const { updateContext, state } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()

  const router = useRouter()
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <Typography variant="h1" className="animate-title">
          You're good to go
        </Typography>
        <Typography variant="p" className="mb-8 w-[640px] max-w-[90vw] animate-title delay-300!">
          Your dashboard is now seeded with usage and verification metrics from a test customer.
          Connect a payment provider when you are ready to charge real customers.
        </Typography>

        <Button
          className="animate-button"
          onClick={() => {
            // clear the flow data
            updateContext({
              flowData: {
                project: undefined,
                customer: undefined,
                subscription: undefined,
                paymentProvider: undefined,
                planVersionId: undefined,
                apiKey: undefined,
                templatePlansCreated: undefined,
                seededMetrics: undefined,
                done: true,
              },
            })

            const projectSlug = state?.context?.flowData?.project?.slug

            if (projectSlug) {
              router.push(`/${workspaceSlug}/${projectSlug}`)
            } else {
              router.push(`/${workspaceSlug}`)
            }

            router.refresh()
          }}
        >
          Go to the app
        </Button>
      </div>
    </div>
  )
}
