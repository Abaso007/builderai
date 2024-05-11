"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

import {
  FEATURE_TYPES,
  FEATURE_TYPES_MAPS,
  TIER_MODES,
  TIER_MODES_MAP,
  USAGE_MODES,
  USAGE_MODES_MAP,
} from "@builderai/db/utils"
import type { PlanVersionFeature } from "@builderai/db/validators"
import { planVersionFeatureInsertBaseSchema } from "@builderai/db/validators"
import { Button } from "@builderai/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@builderai/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@builderai/ui/select"
import { Separator } from "@builderai/ui/separator"

import { SubmitButton } from "~/components/submit-button"
import { toastAction } from "~/lib/toast"
import { useZodForm } from "~/lib/zod-form"
import { api } from "~/trpc/client"
import { usePlanFeaturesList } from "../../_components/use-features"
import { FlatFormFields } from "./flat-form-fields"
import { TierFormFields } from "./tier-form-fields"
import { UsageFormFields } from "./usage-form-fields"

export function FeatureConfigForm({
  setDialogOpen,
  defaultValues,
}: {
  defaultValues: PlanVersionFeature
  setDialogOpen?: (open: boolean) => void
}) {
  const router = useRouter()
  const [_planFeatureList, setPlanFeatureList] = usePlanFeaturesList()
  const editMode = defaultValues.id ? true : false

  // we set all possible values for the form so react-hook-form don't complain
  const controlledDefaultValues = {
    ...defaultValues,
    config: {
      ...defaultValues.config,
      tiers: defaultValues.config?.tiers ?? [
        {
          firstUnit: 1,
          lastUnit: null,
          unitPrice: "0.00",
          flatPrice: null,
        },
      ],
      usageMode: defaultValues.config?.usageMode ?? "tier",
      aggregationMethod: defaultValues.config?.aggregationMethod ?? "sum",
      tierMode: defaultValues.config?.tierMode ?? "volume",
    },
  }

  const form = useZodForm({
    schema: planVersionFeatureInsertBaseSchema,
    defaultValues: controlledDefaultValues,
  })

  const updatePlanVersionFeatures = api.planVersionFeatures.update.useMutation({
    onSuccess: ({ planVersionFeature }) => {
      // update the feature list
      setPlanFeatureList((features) => {
        const index = features.findIndex(
          (feature) => feature.featureId === planVersionFeature.featureId
        )

        features[index] = planVersionFeature

        return features
      })

      form.reset(planVersionFeature)
      toastAction("saved")
      setDialogOpen?.(false)
      router.refresh()
    },
  })

  // reset form values when feature changes
  useEffect(() => {
    form.reset(controlledDefaultValues)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues.id])

  // subscribe to type changes for conditional rendering in the forms
  const featureType = form.watch("featureType")
  const usageMode = form.watch("config.usageMode")

  const onSubmitForm = async (data: PlanVersionFeature) => {
    if (defaultValues.id) {
      await updatePlanVersionFeatures.mutateAsync({
        ...data,
        id: defaultValues.id,
      })
    }
  }

  console.log("error", form.formState.errors)
  console.log("getValues", form.getValues())

  return (
    <Form {...form}>
      <form
        id={"feature-config-form"}
        className="space-y-6"
        onSubmit={form.handleSubmit(onSubmitForm)}
      >
        <div className="flex flex-col gap-2">
          <div className="border-1 items-center rounded-md">
            <div className="space-y-2">
              <div className="rounded-md bg-background-bg p-2 text-center font-semibold shadow-sm">
                Pricing Model
              </div>
              <div className="line-clamp-3 space-y-2 break-all px-2 text-justify text-xs font-normal leading-snug text-muted-foreground">
                All units price based on final tier reached. Needs a record for
                Stripe to track customer service usage.
              </div>
              <div className="flex flex-col gap-1  px-2">
                <FormField
                  control={form.control}
                  name="featureType"
                  render={({ field }) => (
                    <FormItem className="space-y-1">
                      <FormMessage className="self-start px-2" />
                      <Select
                        onValueChange={(value) => {
                          field.onChange(value)
                        }}
                        value={field.value ?? ""}
                      >
                        <FormControl className="truncate">
                          <SelectTrigger className="items-start [&_[data-description]]:hidden">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {FEATURE_TYPES.map((type, index) => (
                            <SelectItem value={type} key={index}>
                              <div className="flex items-start gap-3 text-muted-foreground">
                                <div className="grid gap-0.5">
                                  <p>
                                    {
                                      FEATURE_TYPES_MAPS[
                                        type as keyof typeof FEATURE_TYPES_MAPS
                                      ].label
                                    }
                                  </p>
                                  <p className="text-xs" data-description>
                                    {
                                      FEATURE_TYPES_MAPS[
                                        type as keyof typeof FEATURE_TYPES_MAPS
                                      ].description
                                    }
                                  </p>
                                </div>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />

                {featureType === "usage" && (
                  <FormField
                    control={form.control}
                    name="config.usageMode"
                    render={({ field }) => (
                      <FormItem className="space-y-1">
                        <FormMessage className="self-start px-2" />
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? ""}
                        >
                          <FormControl className="truncate">
                            <SelectTrigger className="items-start [&_[data-description]]:hidden">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {USAGE_MODES.map((mode, index) => (
                              <SelectItem value={mode} key={index}>
                                <div className="flex items-start gap-3 text-muted-foreground">
                                  <div className="grid gap-0.5">
                                    <p>
                                      {
                                        USAGE_MODES_MAP[
                                          mode as keyof typeof USAGE_MODES_MAP
                                        ].label
                                      }
                                    </p>
                                    <p className="text-xs" data-description>
                                      {
                                        USAGE_MODES_MAP[
                                          mode as keyof typeof USAGE_MODES_MAP
                                        ].description
                                      }
                                    </p>
                                  </div>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                )}

                {(featureType === "tier" ||
                  (featureType === "usage" && usageMode === "tier")) && (
                  <FormField
                    control={form.control}
                    name="config.tierMode"
                    render={({ field }) => (
                      <FormItem className="space-y-1">
                        <FormMessage className="self-start px-2" />
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? ""}
                        >
                          <FormControl className="truncate">
                            <SelectTrigger className="items-start [&_[data-description]]:hidden">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {TIER_MODES.map((mode, index) => (
                              <SelectItem value={mode} key={index}>
                                <div className="flex items-start gap-3 text-muted-foreground">
                                  <div className="grid gap-0.5">
                                    <p>
                                      {
                                        TIER_MODES_MAP[
                                          mode as keyof typeof TIER_MODES_MAP
                                        ].label
                                      }
                                    </p>
                                    <p className="text-xs" data-description>
                                      {
                                        TIER_MODES_MAP[
                                          mode as keyof typeof TIER_MODES_MAP
                                        ].description
                                      }
                                    </p>
                                  </div>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        <Separator />

        {featureType === "flat" && <FlatFormFields form={form} />}

        {featureType === "usage" && <UsageFormFields form={form} />}

        {featureType === "tier" && <TierFormFields form={form} />}

        <div className="mt-8 flex justify-end space-x-4">
          <div className="flex flex-col p-4">
            <div className="flex justify-end gap-4">
              <Button
                variant={"link"}
                onClick={(e) => {
                  e.preventDefault()
                  setDialogOpen?.(false)
                }}
              >
                Cancel
              </Button>
              <SubmitButton
                isSubmitting={form.formState.isSubmitting}
                isDisabled={form.formState.isSubmitting}
                label={editMode ? "Update" : "Create"}
              />
            </div>
          </div>
        </div>
      </form>
    </Form>
  )
}
