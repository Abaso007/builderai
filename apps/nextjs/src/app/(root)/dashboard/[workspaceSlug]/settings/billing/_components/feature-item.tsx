"use client"

import { nFormatter } from "@unprice/db/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { BarChart3, Check, Clock, Layers } from "lucide-react"
import type { unprice } from "~/lib/unprice"
import { UsageBar } from "./usage-bar"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>
type FeatureDisplay = UsageConfig["groups"][number]["features"][number]
type TieredDisplay = Extract<FeatureDisplay, { type: "tiered" }>["tieredDisplay"]

function formatNumber(num: number | null | undefined, unit = ""): string {
  if (num === null || num === undefined || num === Number.POSITIVE_INFINITY) {
    return unit ? `∞ ${unit}s` : "∞"
  }
  const formatted = nFormatter(num, { digits: 1 })
  return unit ? `${formatted} ${unit}${Number(formatted) > 1 ? "s" : ""}` : formatted
}

interface FeatureItemProps {
  feature: FeatureDisplay
  planBillingPeriodLabel?: string
}

export function FeatureItem({ feature, planBillingPeriodLabel }: FeatureItemProps) {
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

  // Only show billing frequency if it's different from plan
  const showBillingFrequency = feature.billing.billingFrequencyLabel !== planBillingPeriodLabel

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground">
            {getIcon()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Typography variant="h6" className="truncate font-medium text-foreground text-sm">
                {feature.name}
              </Typography>
              {showBillingFrequency && (
                <TooltipProvider>
                  <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-info text-xs">
                        <Clock className="h-3 w-3" />
                        {feature.billing.billingFrequencyLabel}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      <div className="space-y-1">
                        <div>Billed: {feature.billing.billingFrequencyLabel}</div>
                        <div>Resets: {feature.billing.resetFrequencyLabel}</div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            {feature.description && (
              <p className="mt-0.5 text-muted-foreground text-xs">{feature.description}</p>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-right">
            <div className="font-semibold text-foreground text-sm">{feature.price}</div>
            <div className="text-muted-foreground text-xs">{feature.typeLabel}</div>
          </div>
        </div>
      </div>

      {feature.type === "usage" && (
        <div className="mt-3">
          <UsageBar data={feature.usageBar} />
        </div>
      )}

      {feature.type === "tiered" && (
        <div className="mt-3">
          <TieredUsageDisplay data={feature.tieredDisplay} />
        </div>
      )}

      {feature.type === "flat" && !feature.enabled && (
        <div className="mt-2">
          <span className="text-muted-foreground text-xs">Not enabled</span>
        </div>
      )}
    </div>
  )
}

function TieredUsageDisplay({ data }: { data: TieredDisplay }) {
  // Calculate included amount (billable usage = current - included, so included = current - billable)
  const includedAmount = data.currentUsage - data.billableUsage

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-foreground text-xl">
          {formatNumber(data.currentUsage, data.unit)}
        </span>
        {includedAmount > 0 && (
          <span className="text-muted-foreground text-xs">
            ({formatNumber(includedAmount, data.unit)} included)
          </span>
        )}
      </div>
      {data.currentTierLabel && (
        <p className="text-muted-foreground text-xs">
          Current tier: <span className="font-medium text-foreground">{data.currentTierLabel}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {data.tiers.map((tier, i) => (
          <span
            key={i.toString()}
            className={`rounded px-2 py-0.5 text-xs ${
              tier.isActive
                ? "border border-primary-border bg-primary-bgSubtle font-medium text-primary"
                : "border border-background-border bg-background-bgSubtle text-muted-foreground"
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
