"use client"

import { ChevronDown } from "lucide-react"
import { useState } from "react"
import type { UseFormReturn } from "react-hook-form"

import type {
  AggregationMethod,
  PlanVersionFeatureInsert,
  Currency,
} from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@unprice/ui/collapsible"
import { Separator } from "@unprice/ui/separator"
import { cn } from "@unprice/ui/utils"

import {
  BillingConfigFeatureFormField,
  LimitFormField,
  OverageStrategyFormField,
  PriceFormField,
  ResetConfigFeatureFormField,
  TierFormField,
  UnitsFormField,
} from "./fields-form"
import { MeterConfigFormField } from "./meter-config-form-field"

export function UsageFormFields({
  form,
  currency,
  isDisabled,
  units,
  legacyAggregationMethod,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  currency: Currency
  isDisabled?: boolean
  units: string
  legacyAggregationMethod?: AggregationMethod
}) {
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)

  // Watch aggregation method to conditionally show reset config
  // Methods ending with "_all" (sum_all, count_all, max_all) are lifetime/accumulated
  // and don't need reset configuration
  const aggregationMethod = form.watch("meterConfig.aggregationMethod") ?? legacyAggregationMethod
  const isLifetimeAggregation = aggregationMethod?.endsWith("_all")

  return (
    <div className="flex flex-col space-y-6">
      {/* Core settings - always visible */}
      <MeterConfigFormField
        form={form}
        isDisabled={isDisabled}
        legacyAggregationMethod={legacyAggregationMethod}
      />

      <div className="flex w-full justify-between">
        <LimitFormField form={form} isDisabled={isDisabled} units={units} />
      </div>

      <Separator />

      {/* Pricing section based on usage mode */}
      {form.getValues("config.usageMode") === "unit" && (
        <div className="flex w-full justify-between">
          <PriceFormField form={form} currency={currency} isDisabled={isDisabled} />
        </div>
      )}

      {form.getValues("config.usageMode") === "tier" && (
        <div className="flex w-full justify-between">
          <TierFormField form={form} currency={currency} isDisabled={isDisabled} />
        </div>
      )}

      {form.getValues("config.usageMode") === "package" && (
        <div className="flex w-full justify-between">
          <div className="flex w-full flex-col gap-1">
            <PriceFormField form={form} currency={currency} isDisabled={isDisabled} />
            <UnitsFormField form={form} isDisabled={isDisabled} />
          </div>
        </div>
      )}

      <Separator />

      {/* Advanced settings - collapsible */}
      <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="flex w-full items-center justify-between bg-background-bgSubtle px-4 py-3 font-medium text-sm hover:bg-background-bgHover"
          >
            <span>Advanced Settings</span>
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform duration-200",
                isAdvancedOpen && "rotate-180"
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-4 flex flex-col gap-6 rounded-md border bg-background-bgSubtle/50 p-4">
            <BillingConfigFeatureFormField form={form} isDisabled={isDisabled} />
            {/* Only show reset config for period-based aggregation methods */}
            {!isLifetimeAggregation && (
              <ResetConfigFeatureFormField form={form} isDisabled={isDisabled} />
            )}
            <Separator />
            <OverageStrategyFormField form={form} isDisabled={isDisabled} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
