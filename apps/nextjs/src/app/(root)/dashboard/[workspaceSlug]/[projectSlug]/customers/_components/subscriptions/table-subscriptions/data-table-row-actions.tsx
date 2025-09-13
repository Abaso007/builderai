"use client"

import type { Row } from "@tanstack/react-table"
import { Button } from "@unprice/ui/button"

import { useMutation } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { MoreVertical } from "lucide-react"
import { useParams } from "next/navigation"
import { startTransition, useState } from "react"
import { z } from "zod"
import { PropagationStopper } from "~/components/prevent-propagation"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

type PlanVersion = RouterOutputs["plans"]["getSubscriptionsBySlug"]["subscriptions"][number]
const schemaPlanVersion = z.custom<PlanVersion>()

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const { customer, ...subscription } = schemaPlanVersion.parse(row.original)
  const { workspaceSlug, projectSlug } = useParams()
  const [open, setOpen] = useState(false)

  const trpc = useTRPC()
  const subscriptionId = subscription.id

  const generateInvoice = useMutation(trpc.subscriptions.invoice.mutationOptions({}))

  const renewSubscription = useMutation(trpc.subscriptions.machine.mutationOptions({}))

  const generateBillingPeriods = useMutation(trpc.subscriptions.machine.mutationOptions({}))

  function onGenerateInvoice() {
    startTransition(() => {
      toast.promise(
        generateInvoice.mutateAsync({
          subscriptionId: subscriptionId,
        }),
        {
          loading: "Generating invoice...",
          success: "Invoice generated",
        }
      )
    })
  }

  function onRenewSubscription() {
    startTransition(() => {
      toast.promise(
        renewSubscription.mutateAsync({
          subscriptionId: subscriptionId,
          event: "renew",
        }),
        {
          loading: "Renewing subscription...",
          success: "Subscription renewed",
        }
      )
    })
  }

  function onGenerateBillingPeriods() {
    startTransition(() => {
      toast.promise(
        generateBillingPeriods.mutateAsync({
          subscriptionId: subscriptionId,
          event: "billing_period",
        }),
        {
          loading: "Generating billing periods...",
          success: "Billing periods generated",
        }
      )
    })
  }

  return (
    <PropagationStopper>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button aria-haspopup="true" size="icon" variant="ghost">
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Toggle menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <SuperLink
              href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/${subscriptionId}`}
            >
              See Details
            </SuperLink>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault()
              onGenerateInvoice()
              setOpen(false)
            }}
            disabled={generateInvoice.isPending}
          >
            Generate Invoice
            {generateInvoice.isPending && <LoadingAnimation className={"ml-2"} />}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault()
              onRenewSubscription()
              setOpen(false)
            }}
            disabled={renewSubscription.isPending}
          >
            Renew Subscription
            {renewSubscription.isPending && <LoadingAnimation className={"ml-2"} />}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault()
              onGenerateBillingPeriods()
              setOpen(false)
            }}
          >
            Generate Billing Periods
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PropagationStopper>
  )
}
