"use client"

import { useState } from "react"

import type { InsertSubscription } from "@unprice/db/validators"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@unprice/ui/sheet"
import { SubscriptionForm } from "./subscription-form"

export function SubscriptionSheet({
  defaultValues,
  children,
}: {
  children?: React.ReactNode
  defaultValues?: InsertSubscription
}) {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent className="hide-scrollbar flex max-h-screen w-full flex-col space-y-4 overflow-y-scroll md:w-1/2 lg:w-[700px]">
        <SheetHeader>
          <SheetTitle className="text-2xl">Subscription Form</SheetTitle>
          <SheetDescription>Configure the subscription for the customer</SheetDescription>
        </SheetHeader>

        <SubscriptionForm
          setDialogOpen={setIsOpen}
          defaultValues={
            defaultValues ?? {
              customerId: "",
              phases: [],
              timezone: "UTC",
            }
          }
        />
      </SheetContent>
    </Sheet>
  )
}
