"use client"
import type { InsertSubscription, InsertSubscriptionPhase } from "@unprice/db/validators"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { FormDescription, FormLabel, FormMessage } from "@unprice/ui/form"
import { Separator } from "@unprice/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@unprice/ui/sheet"
import { toast } from "@unprice/ui/sonner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { LayoutGrid, PencilIcon, TrashIcon, X } from "lucide-react"
import { useEffect, useState } from "react"
import { type FieldErrors, type UseFormReturn, useFieldArray } from "react-hook-form"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { PropagationStopper } from "~/components/prevent-propagation"
import { formatDate } from "~/lib/dates"
import { api } from "~/trpc/client"
import { SubscriptionPhaseForm } from "./subscription-phase-form"

import { startTransition } from "react"

export default function SubscriptionPhaseFormField({
  form,
  subscriptionId,
  timezone,
}: {
  form: UseFormReturn<InsertSubscription>
  subscriptionId: string
  timezone: string
}) {
  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: "phases",
    keyName: "_id",
  })

  const [dialogOpen, setDialogOpen] = useState(false)

  const selectedCustomer = form.watch("customerId")

  const defaultValuesPhase = {
    customerId: form.getValues("customerId"),
    id: "",
    planVersionId: "",
    config: [],
    items: [],
    startCycle: 1,
    whenToBill: "pay_in_advance",
    collectionMethod: "charge_automatically",
    startAt: Date.now(),
    subscriptionId,
  } as InsertSubscriptionPhase

  const [selectedPhase, setSelectedPhase] = useState<InsertSubscriptionPhase>(defaultValuesPhase)

  const { errors } = form.formState

  // this query is deduplicated from the parent component
  const { data: planVersions } = api.planVersions.listByActiveProject.useQuery({
    enterprisePlan: true,
    published: true,
  })

  const removePhase = api.subscriptions.removePhase.useMutation()

  const [isDelete, setConfirmDelete] = useState<Map<string, boolean>>(
    new Map<string, boolean>(fields.map((item) => [item.id, false] as [string, boolean]))
  )

  const getErrorMessage = (
    errors: FieldErrors<InsertSubscriptionPhase>,
    field: string
  ): string | undefined => {
    // show the errros for the given field, if not found, show the all errors
    const error = errors[field as keyof typeof errors]

    if (error && Array.isArray(error)) {
      return error
        .map((e) => {
          const keys = Object.keys(e)

          return keys
            .map((key) => {
              return `${key}: ${e[key as keyof typeof e].message}`
            })
            .join(" ")
        })
        .join(" ")
    }

    return error && typeof error === "object" && "message" in error
      ? (error.message as string)
      : undefined
  }

  useEffect(() => {
    if (selectedCustomer) {
      setSelectedPhase({
        ...defaultValuesPhase,
        customerId: selectedCustomer,
      })

      form.clearErrors("customerId")
    }
  }, [selectedCustomer])

  function onRemovePhase(phaseId: string, callback: () => void) {
    startTransition(() => {
      toast.promise(
        removePhase
          .mutateAsync({
            id: phaseId,
          })
          .then(() => {
            callback()
          }),
        {
          loading: "Removing phase...",
          success: "Phase removed",
        }
      )
    })
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <Separator className="my-2" />
      <div className="mb-4 flex flex-col gap-2">
        <FormLabel
          className={cn({
            "text-destructive": errors.phases,
          })}
        >
          <Typography variant="h5">Phases configuration</Typography>
        </FormLabel>
        <FormDescription>
          Each phase represents a different period of time for the subscription. You can add trial
          days for avery phase, and configure the billing method. The subscription needs to have at
          least one phase.
        </FormDescription>
        {errors.phases && <FormMessage>{getErrorMessage(errors, "phases")}</FormMessage>}
      </div>

      <div className="flex items-center justify-center px-1 py-2">
        {fields.length > 0 ? (
          <div className="flex w-full flex-col gap-4">
            {fields.map((phase, index) => {
              const selectedPlanVersion = planVersions?.planVersions.find(
                (version) => version.id === phase.planVersionId
              )

              const now = Date.now()
              const isActive =
                phase.startAt < now && (phase.endAt ?? Number.POSITIVE_INFINITY) > now

              if (!selectedPlanVersion) return null

              return (
                <div key={phase.id} className="relative">
                  <div
                    className={cn(
                      "flex w-full flex-col gap-2 rounded-md border border-dashed px-4 py-4",
                      {
                        "border-destructive": errors.phases?.[index],
                      }
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col gap-2">
                        <Typography variant="h5">
                          {index + 1}. {selectedPlanVersion.title} v{selectedPlanVersion.version} -{" "}
                          {selectedPlanVersion.billingPeriod}
                          {phase.trialDays && phase.trialDays > 0 ? (
                            <Badge className="ml-2">{phase.trialDays} days trial</Badge>
                          ) : (
                            <Badge className="ml-2">no trial</Badge>
                          )}
                          {isActive && (
                            <div className="mx-2 inline-flex items-center font-semibold text-info text-xs">
                              <span className="flex h-2 w-2 rounded-full bg-info" />
                              <span className="ml-1">{"active phase"}</span>
                            </div>
                          )}
                        </Typography>
                        <Typography variant="p" affects="removePaddingMargin">
                          from {formatDate(phase.startAt, timezone, "MMM dd, yyyy")} to{" "}
                          {phase.endAt
                            ? formatDate(phase.endAt, timezone, "MMM dd, yyyy")
                            : "forever"}
                        </Typography>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size={"xs"}
                          onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()

                            setSelectedPhase({
                              ...phase,
                              subscriptionId,
                            })
                            setDialogOpen(true)
                          }}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>

                        {fields.length > 1 && isDelete.get(phase._id) && (
                          <div className="flex flex-row items-center">
                            <Button
                              className="px-0 text-destructive"
                              variant="link"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation()
                                e.preventDefault()

                                const phaseId = phase.id

                                if (!phaseId) return

                                onRemovePhase(phaseId, () => {
                                  remove(index)
                                  setConfirmDelete((prev) => new Map(prev.set(phase._id, false)))
                                })
                              }}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        )}

                        {fields.length > 1 && !isDelete.get(phase._id) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                className="px-0 text-destructive"
                                variant="link"
                                size="icon"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  e.preventDefault()
                                  setConfirmDelete((prev) => new Map(prev.set(phase._id, true)))

                                  setTimeout(() => {
                                    setConfirmDelete((prev) => new Map(prev.set(phase._id, false)))
                                  }, 2000)
                                }}
                              >
                                <TrashIcon className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="max-w-[200px] text-sm">
                                Remove this phase from the subscription
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Add connecting line between phases */}
                  {index < fields.length - 1 && (
                    <div className="-mb-4 absolute bottom-0 left-1/2 h-4 w-0.5 bg-border" />
                  )}
                </div>
              )
            })}

            <div className="mt-6 flex justify-center">
              {fields.length > 0 && !fields[fields.length - 1]?.endAt ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size={"sm"}
                      className="w-1/2 cursor-not-allowed opacity-50"
                      aria-disabled
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                      }}
                    >
                      Add phase
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="w-56">
                    You can't add a new phase if the last phase is not ended. Add an end date to the
                    last phase
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  size={"sm"}
                  className="w-1/2"
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()

                    if (fields.length > 0) {
                      const lastPhase = fields[fields.length - 1]
                      const endAt = lastPhase?.endAt ?? Date.now()
                      const startAt = new Date(endAt).getTime() + 1

                      if (lastPhase) {
                        setSelectedPhase({
                          ...defaultValuesPhase,
                          // add one day to the end date of the last phase
                          startAt: startAt,
                        })
                      } else {
                        setSelectedPhase({
                          ...defaultValuesPhase,
                          startAt: startAt,
                        })
                      }
                    } else {
                      setSelectedPhase(defaultValuesPhase)
                    }

                    setDialogOpen(true)
                  }}
                >
                  Add phase
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex w-full items-center justify-center px-1 py-2">
            <EmptyPlaceholder className="min-h-[200px]">
              <EmptyPlaceholder.Icon>
                <LayoutGrid className="h-8 w-8" />
              </EmptyPlaceholder.Icon>
              <EmptyPlaceholder.Title>No phases created</EmptyPlaceholder.Title>
              <EmptyPlaceholder.Description>
                Add a phase to start the subscription
              </EmptyPlaceholder.Description>
              <EmptyPlaceholder.Action>
                <Button
                  size={"sm"}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()

                    if (!selectedCustomer) {
                      form.setError("customerId", {
                        message: "You need to select a customer first",
                      })
                      return
                    }

                    setDialogOpen(true)
                  }}
                >
                  Add phase
                </Button>
              </EmptyPlaceholder.Action>
            </EmptyPlaceholder>
          </div>
        )}
      </div>
      <PropagationStopper>
        <Sheet open={dialogOpen} onOpenChange={setDialogOpen}>
          <SheetContent className="hide-scrollbar flex max-h-screen w-full flex-col space-y-4 overflow-y-scroll lg:w-[700px] md:w-1/2">
            <SheetHeader>
              <SheetTitle className="text-2xl">Subscription Form</SheetTitle>
              <SheetDescription>Configure the subscription for the customer</SheetDescription>
            </SheetHeader>

            <SubscriptionPhaseForm
              defaultValues={{
                ...selectedPhase,
                customerId: selectedCustomer,
              }}
              onSubmit={(data) => {
                if (data.id !== "") {
                  const index = fields.findIndex((phase) => phase.id === data.id)
                  if (index !== -1) {
                    update(index, data)
                  } else {
                    append(data)
                  }
                } else {
                  append(data)
                }
              }}
              setDialogOpen={setDialogOpen}
            />
          </SheetContent>
        </Sheet>
      </PropagationStopper>
    </div>
  )
}
