"use client"

import { startTransition } from "react"
import { useParams, useRouter } from "next/navigation"
import type { Row } from "@tanstack/react-table"

import { planSelectBaseSchema } from "@builderai/db/validators"
import { Button } from "@builderai/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@builderai/ui/dropdown-menu"
import { Ellipsis } from "@builderai/ui/icons"

import { toastAction } from "~/lib/toast"
import { api } from "~/trpc/client"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({
  row,
}: DataTableRowActionsProps<TData>) {
  const plan = planSelectBaseSchema.parse(row.original)
  const router = useRouter()
  const projectSlug = useParams().projectSlug as string
  const workspaceSlug = useParams().workspaceSlug as string

  const revokeApiKeys = api.apikeys.revokeApiKeys.useMutation({
    onSuccess: () => {
      toastAction("success")
      router.refresh()
    },
  })

  const rollApiKey = api.apikeys.rollApiKey.useMutation({
    onSuccess: () => {
      toastAction("success")
      router.refresh()
    },
  })

  const createNewVersion = api.plans.createNewVersion.useMutation({
    onSuccess: (data) => {
      const { planVersion } = data
      toastAction("success")
      router.push(
        `/${workspaceSlug}/${projectSlug}/plans/${plan?.slug}/${planVersion?.version}/overview`
      )
    },
  })

  function onRevokeKey() {
    startTransition(() => {
      void revokeApiKeys.mutateAsync({
        ids: [plan.id],
        projectSlug,
      })
    })
  }

  function onRollKey() {
    startTransition(() => {
      void rollApiKey.mutateAsync({
        id: plan.id,
        projectSlug,
      })
    })
  }

  function onCreateVersion() {
    startTransition(() => {
      void createNewVersion.mutateAsync({
        planId: plan.id,
      })
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onCreateVersion()
          }}
        >
          Create a version
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onRevokeKey()
          }}
          className="text-destructive"
        >
          Revoke Key
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault()
            onRollKey()
          }}
          className="text-destructive"
        >
          Roll Key
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
