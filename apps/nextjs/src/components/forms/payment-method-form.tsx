"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import type { PaymentProvider } from "@unprice/db/validators"
import { SubmitButton } from "~/components/submit-button"
import { useTRPC } from "~/trpc/client"

export function PaymentMethodButton({
  customerId,
  successUrl,
  cancelUrl,
  paymentProvider,
}: {
  customerId: string
  successUrl: string
  cancelUrl: string
  paymentProvider: PaymentProvider
}) {
  const trpc = useTRPC()
  const { isLoading, data } = useQuery(
    trpc.customers.listPaymentMethods.queryOptions(
      {
        customerId,
        provider: paymentProvider,
      },
      {
        enabled: !!customerId,
        retry: false,
      }
    )
  )

  const createSession = useMutation(
    trpc.customers.createPaymentMethod.mutationOptions({
      onSuccess: (data) => {
        if (data?.url) window.location.href = data?.url
      },
    })
  )

  const defaultPaymentMethod = data?.paymentMethods.at(0)

  return (
    <SubmitButton
      variant="default"
      size="sm"
      className="w-56"
      onClick={() => {
        createSession.mutate({
          paymentProvider: paymentProvider,
          customerId,
          successUrl,
          cancelUrl,
        })
      }}
      isSubmitting={createSession.isPending}
      isDisabled={createSession.isPending || isLoading}
      isLoading={isLoading}
      label={!defaultPaymentMethod ? "Add Payment Method" : "Billing Portal"}
    />
  )
}
