"use client"
import { Button } from "@unprice/ui/button"

import { useMutation } from "@tanstack/react-query"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { CreditCard } from "lucide-react"
import { useRouter } from "next/navigation"
import { startTransition } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

type SubscriptionInvoice = RouterOutputs["customers"]["getInvoiceById"]["invoice"]

export function InvoiceActions({ invoice }: { invoice: SubscriptionInvoice }) {
  const router = useRouter()
  const trpc = useTRPC()
  const subscriptionId = invoice.subscriptionId
  const invoiceId = invoice.id

  const machine = useMutation(trpc.subscriptions.machine.mutationOptions({}))

  function onFinalizeInvoice() {
    startTransition(() => {
      toast.promise(
        machine
          .mutateAsync({
            subscriptionId: subscriptionId,
            event: "finalize_invoice",
            invoiceId: invoiceId,
          })
          .then(() => {
            router.refresh()
          }),
        {
          loading: "Finalizing invoice...",
          success: "Invoice finalized",
        }
      )
    })
  }

  function onCollectPayment() {
    startTransition(() => {
      toast.promise(
        machine
          .mutateAsync({
            subscriptionId: subscriptionId,
            event: "collect_payment",
            invoiceId: invoiceId,
          })
          .then(() => {
            router.refresh()
          }),
        {
          loading: "Collecting payment...",
          success: "Payment collected",
        }
      )
    })
  }

  return (
    <Button
      onClick={(e) => {
        e.preventDefault()

        if (["draft"].includes(invoice.status)) {
          onFinalizeInvoice()
        } else if (["waiting", "unpaid", "failed"].includes(invoice.status)) {
          onCollectPayment()
        } else if (["void"].includes(invoice.status)) {
          toast.success("Invoice is already voided, no link available")
        } else if (["paid"].includes(invoice.status)) {
          window.open(invoice.invoicePaymentProviderUrl ?? "", "_blank")
        } else {
          toast.error("Invoice is in an unknown status")
        }
      }}
      disabled={machine.isPending}
    >
      <CreditCard className="mr-2 h-4 w-4" />
      {["draft"].includes(invoice.status)
        ? "Finalize Invoice"
        : ["waiting", "unpaid", "failed"].includes(invoice.status)
          ? "Collect Payment"
          : ["paid", "void"].includes(invoice.status)
            ? "View Invoice"
            : "Unknown Status"}
    </Button>
  )
}
