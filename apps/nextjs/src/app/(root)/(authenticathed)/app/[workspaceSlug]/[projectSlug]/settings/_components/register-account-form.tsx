"use client"

import { Button } from "@builderai/ui/button"

export function RegisterAccountForm() {
  // const createAccountLink = api.stripe.createLinkAccount.useMutation({
  //   onSettled: (data) => {
  //     if (data?.url) window.location.href = data?.url
  //   },
  // })

  return (
    <Button
      onClick={() => {
        // createAccountLink.mutate()
      }}
    >
      {"Update Stripe Verification"}
    </Button>
  )
}
