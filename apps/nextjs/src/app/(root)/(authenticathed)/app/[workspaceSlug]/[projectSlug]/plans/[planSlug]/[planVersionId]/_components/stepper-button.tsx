"use client"

import { usePathname } from "next/navigation"
import { ChevronRight } from "lucide-react"

import { Button } from "@builderai/ui/button"

import { SuperLink } from "~/components/super-link"
import { PlanVersionPublish } from "../../../_components/plan-version-actions"

// TODO: if the version is already published, publish button should be disabled
export default function StepperButton({
  baseUrl,
  planVersionId,
}: {
  baseUrl: string
  planVersionId: string
}) {
  const step = usePathname().split("/").pop()

  if (step === planVersionId) {
    return (
      <SuperLink href={`${baseUrl}/addons`}>
        <Button>
          continue
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </SuperLink>
    )
  }

  if (step === "addons") {
    return (
      <SuperLink href={`${baseUrl}/review`}>
        <Button>
          continue
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </SuperLink>
    )
  }

  return <PlanVersionPublish planVersionId={planVersionId} />
}
