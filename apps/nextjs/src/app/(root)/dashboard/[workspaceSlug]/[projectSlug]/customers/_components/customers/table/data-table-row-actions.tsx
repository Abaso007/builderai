"use client"

import type { Row } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"

import { useMutation } from "@tanstack/react-query"
import { customerSelectSchema } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unprice/ui/dropdown-menu"
import { useParams, useRouter } from "next/navigation"
import { startTransition } from "react"
import { SuperLink } from "~/components/super-link"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"
import { CustomerForm } from "../customer-form"

interface DataTableRowActionsProps<TData> {
  row: Row<TData>
}

export function DataTableRowActions<TData>({ row }: DataTableRowActionsProps<TData>) {
  const customer = customerSelectSchema.parse(row.original)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const { workspaceSlug, projectSlug } = useParams()
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customer.id}`
  const router = useRouter()

  const trpc = useTRPC()

  const test = useMutation(
    trpc.customers.test.mutationOptions({
      onSuccess: () => {
        router.refresh()
      },
    })
  )

  function onTest() {
    startTransition(() => {
      toast.promise(
        test.mutateAsync({
          customerId: customer.id,
        }),
        {
          loading: "Testing...",
          success: "Test completed",
        }
      )
    })
  }

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-8 w-8 p-0 data-[state=open]:bg-accent">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DialogTrigger asChild>
            <DropdownMenuItem>Edit Customer</DropdownMenuItem>
          </DialogTrigger>
          <DialogTrigger asChild>
            <DropdownMenuItem>
              <SuperLink href={baseUrl}>Manage Customer Details</SuperLink>
            </DropdownMenuItem>
          </DialogTrigger>
          <DropdownMenuItem onClick={onTest} disabled={test.isPending}>
            Test
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DialogContent className="max-h-[95vh] md:max-w-screen-md">
        <DialogHeader>
          <DialogTitle>Customer Form</DialogTitle>
          <DialogDescription>Modify the customer details below.</DialogDescription>
        </DialogHeader>
        <CustomerForm defaultValues={customer} setDialogOpen={setDialogOpen} />
      </DialogContent>
    </Dialog>
  )
}
