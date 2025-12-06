"use client"

import { formatMoney } from "@unprice/db/utils"
import { nFormatter } from "@unprice/db/utils"
import { Badge } from "@unprice/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@unprice/ui/tooltip"
import { BarChart3, Check, Clock, Layers, RefreshCw } from "lucide-react"
import type { unprice } from "~/lib/unprice"
import { GrantsTooltip } from "./grants-tooltip"
import { UsageBar } from "./usage-bar"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>
type FeatureDisplay = UsageConfig["groups"][number]["features"][number]
type TieredDisplay = Extract<FeatureDisplay, { type: "tiered" }>["tieredDisplay"]
type GrantsDisplay = {
  grants: Array<{
    id: string
    name: string
    amount: number
    isFree: boolean
    source?: string
    percentOfTotal: number
  }>
  totalFromGrants: number
  paidGrants: Array<{
    id: string
    name: string
    amount: number
    isFree: boolean
    source?: string
    percentOfTotal: number
  }>
  freeGrants: Array<{
    id: string
    name: string
    amount: number
    isFree: boolean
    source?: string
    percentOfTotal: number
  }>
}

function formatNumber(num: number | null | undefined, unit = ""): string {
  if (num === null || num === undefined || num === Number.POSITIVE_INFINITY) {
    return unit ? `∞ ${unit}` : "∞"
  }
  const formatted = nFormatter(num, { digits: 1 })
  return unit ? `${formatted} ${unit}` : formatted
}

interface FeatureItemProps {
  feature: FeatureDisplay
}

export function FeatureItem({ feature }: FeatureItemProps) {
  const getIcon = () => {
    switch (feature.type) {
      case "flat":
        return <Check className="h-4 w-4" />
      case "tiered":
        return <Layers className="h-4 w-4" />
      case "usage":
        return <BarChart3 className="h-4 w-4" />
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground">
            {getIcon()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="truncate font-medium text-foreground">{feature.name}</h4>
              <Badge className="ml-2" variant={"outline"}>
                {feature.typeLabel}
              </Badge>
              {feature.billing.hasDifferentBilling &&
                (feature.type === "flat" || feature.type === "usage") && (
                  <TooltipProvider>
                    <Tooltip delayDuration={200}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-secondary text-xs">
                          <Clock className="h-3 w-3" />
                          {feature.billing.billingFrequencyLabel}
                          {feature.billing.resetFrequency &&
                            feature.billing.resetFrequency !== feature.billing.billingFrequency && (
                              <>
                                <RefreshCw className="ml-0.5 h-2.5 w-2.5" />
                                {feature.billing.resetFrequencyLabel}
                              </>
                            )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <div className="space-y-1">
                          {feature.billing.billingFrequency && (
                            <div>Billed: {feature.billing.billingFrequency}</div>
                          )}
                          {feature.billing.resetFrequency && (
                            <div>Resets: {feature.billing.resetFrequency}</div>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
            </div>
            {feature.description && (
              <p className="mt-0.5 truncate text-muted-foreground text-sm">{feature.description}</p>
            )}
            {feature.type === "usage" && "grantsDisplay" in feature && feature.grantsDisplay ? (
              <div className="mt-1.5">
                <GrantsTooltip
                  data={feature.grantsDisplay as unknown as GrantsDisplay}
                  unit={feature.usageBar.unit}
                />
              </div>
            ) : null}
            {feature.type === "tiered" && "grantsDisplay" in feature && feature.grantsDisplay ? (
              <div className="mt-1.5">
                <GrantsTooltip
                  data={feature.grantsDisplay as unknown as GrantsDisplay}
                  unit={feature.tieredDisplay.unit}
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 text-right">
          {!feature.isIncluded ? (
            <span className="font-medium text-sm">
              {formatMoney(feature.price.toString(), feature.currency)}
            </span>
          ) : (
            <span className="text-muted-foreground text-sm">Included</span>
          )}
        </div>
      </div>

      {feature.type === "usage" && (
        <div className="mt-3 ml-11">
          <UsageBar data={feature.usageBar} />
        </div>
      )}

      {feature.type === "tiered" && (
        <div className="mt-3 ml-11">
          <TieredUsageDisplay data={feature.tieredDisplay} />
        </div>
      )}

      {feature.type === "flat" && !feature.enabled && (
        <div className="mt-2 ml-11">
          <span className="text-muted-foreground text-xs">Not enabled</span>
        </div>
      )}
    </div>
  )
}

function TieredUsageDisplay({ data }: { data: TieredDisplay }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-2xl text-foreground">
          {formatNumber(data.currentUsage, data.unit)}
        </span>
        <span className="text-muted-foreground text-sm">{data.unit}</span>
        {data.freeAmount > 0 && (
          <span className="text-success text-xs">
            ({formatNumber(data.freeAmount, data.unit)} free)
          </span>
        )}
      </div>
      {data.currentTierLabel && (
        <p className="text-muted-foreground text-xs">
          Current tier: <span className="text-foreground">{data.currentTierLabel}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {data.tiers.map((tier, i) => (
          <span
            key={i.toString()}
            className={`rounded px-2 py-0.5 text-xs ${
              tier.isActive
                ? "border border-primary-border bg-primary-bgSubtle text-primary"
                : "border border-background-border bg-background-bgSubtle"
            }`}
          >
            {formatNumber(tier.min)}-{tier.max === null ? "∞" : formatNumber(tier.max)}: $
            {tier.pricePerUnit}
          </span>
        ))}
      </div>
    </div>
  )
}
