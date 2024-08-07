"use client"

import { useRouter } from "next/navigation"
import { startTransition } from "react"

import { Button } from "@builderai/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@builderai/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@builderai/ui/dialog"
import { Warning } from "@builderai/ui/icons"

import type { Workspace } from "@builderai/db/validators"
import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { api } from "~/trpc/client"

export function DeleteWorkspace({ workspace }: { workspace: Workspace }) {
  const router = useRouter()
  const isPersonal = workspace.isPersonal

  const apiUtils = api.useUtils()

  const title = "Delete"
  const description = "This will delete the workspace and all of its data."

  const deleteWorkspace = api.workspaces.delete.useMutation({
    onSettled: async () => {
      await apiUtils.projects.listByWorkspace.invalidate()
      router.refresh()
    },
    onSuccess: () => {
      toastAction("deleted")
      router.push("/")
    },
  })

  function handleDelete() {
    startTransition(() => {
      deleteWorkspace.mutate({
        slug: workspace.slug,
      })
    })
  }

  return (
    <Card className="border-danger">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter className="border-t px-6 py-4">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" disabled={!!isPersonal}>
              {title}
            </Button>
          </DialogTrigger>
          {!!isPersonal && (
            <span className="mr-auto px-2 text-muted-foreground text-xs">
              You can not delete your personal workspace. Contact support if you want to delete your
              account.
            </span>
          )}
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center font-bold text-destructive">
              <Warning className="mr-2 h-6 w-6" />
              <p>This action can not be reverted</p>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>

              <SubmitButton
                component="spinner"
                variant="destructive"
                isDisabled={deleteWorkspace.isPending}
                isSubmitting={deleteWorkspace.isPending}
                label="I'm sure. Delete this workspace"
                onClick={(e) => {
                  e.preventDefault()
                  handleDelete()
                }}
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  )
}
