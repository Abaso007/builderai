"use client"

import { useState } from "react"

import type { InsertPlanVersion } from "@builderai/db/validators"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@builderai/ui/dialog"

import { PlanVersionForm } from "./plan-version-form"

export function PlanVersionDialog({
  defaultValues,
  children,
}: {
  label?: string
  defaultValues?: InsertPlanVersion
  children?: React.ReactNode
}) {
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-screen overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>Plan version form</DialogTitle>

          <DialogDescription>Modify the plan version details below.</DialogDescription>
        </DialogHeader>

        <PlanVersionForm
          defaultValues={
            defaultValues ?? {
              title: "",
              planId: "",
              projectId: "",
              currency: "USD",
              planType: "recurring",
              paymentProvider: "stripe",
            }
          }
          setDialogOpen={setDialogOpen}
        />
      </DialogContent>
    </Dialog>
  )
}
