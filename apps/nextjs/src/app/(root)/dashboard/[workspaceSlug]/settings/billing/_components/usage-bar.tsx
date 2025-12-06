"use client"

import { nFormatter } from "@unprice/db/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@unprice/ui/tooltip"
import { AlertTriangle, Ban, TrendingUp } from "lucide-react"
import type { unprice } from "~/lib/unprice"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>
type FeatureDisplay = UsageConfig["groups"][number]["features"][number]
type UsageBarDisplay = Extract<FeatureDisplay, { type: "usage" }>["usageBar"]

interface UsageBarProps {
  data: UsageBarDisplay
}

function formatNumber(num: number | null | undefined, unit = ""): string {
  if (num === null || num === undefined || num === Number.POSITIVE_INFINITY) {
    return unit ? `∞ ${unit}` : "∞"
  }
  const formatted = nFormatter(num, { digits: 1 })
  return unit ? `${formatted} ${unit}` : formatted
}

export function UsageBar({ data }: UsageBarProps) {
  const {
    current,
    included,
    limit,
    freeAmount,
    limitType,
    unit,
    currentPercent,
    includedPercent,
    freePercent,
    limitPercent,
    isOverLimit,
    isOverIncluded,
    isNearLimit,
    statusMessage,
    statusType,
  } = data

  const currentFormatted = formatNumber(current, unit)
  const limitFormatted = limit !== undefined ? formatNumber(limit, unit) : null
  const includedFormatted = formatNumber(included, unit)
  const freeAmountFormatted = formatNumber(freeAmount, unit)

  const hasHardLimit = limitType === "hard"
  const hasSoftLimit = limitType === "soft"
  const hasNoLimit = limitType === "none"

  // Calculate barColor based on usage state
  const barColor: "primary" | "amber" | "destructive" | "overage" =
    isOverLimit && hasHardLimit
      ? "destructive"
      : isOverIncluded
        ? "overage"
        : isNearLimit
          ? "amber"
          : "primary"

  const barColorClass = {
    primary: "bg-info-borderHover",
    amber: "bg-primary-borderHover",
    destructive: "bg-warning-borderHover",
    overage: "bg-danger-borderHover",
  }[barColor]

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-2xl text-foreground">{currentFormatted}</span>
          <span className="text-muted-foreground text-sm">
            {limitFormatted ? `of ${limitFormatted} ${unit}` : unit}
          </span>
          {limitFormatted && (
            <TooltipProvider>
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <span
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                      hasHardLimit
                        ? "bg-destructive/10 text-destructive"
                        : hasSoftLimit
                          ? "text-warning"
                          : "text-success"
                    }`}
                  >
                    {hasHardLimit && <Ban className="h-3 w-3" />}
                    {hasSoftLimit && <AlertTriangle className="h-3 w-3" />}
                    {hasNoLimit && <TrendingUp className="h-3 w-3" />}
                    {hasHardLimit ? "Hard limit" : hasSoftLimit ? "Soft limit" : "Overuse OK"}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-48 text-xs">
                  {hasHardLimit && "Usage will be blocked when limit is reached"}
                  {hasSoftLimit && "You'll receive a warning but can continue using"}
                  {hasNoLimit && "No limit - overage will be billed per unit"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <div className="text-right">
          {data.included > 0 && (
            <span className="text-muted-foreground text-xs">
              {includedFormatted} included
              {freeAmount > 0 && (
                <span className="text-success"> ({freeAmountFormatted} free)</span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="relative h-2 w-full overflow-hidden rounded-full bg-background-bgHover">
        {freeAmount > 0 && (
          <div
            className="absolute top-0 h-full rounded-l-full bg-info-borderHover"
            style={{ width: `${freePercent}%` }}
          />
        )}
        {data.included > 0 && includedPercent < 100 && (
          <div
            className="absolute top-0 h-full w-px bg-muted-foreground"
            style={{ left: `${includedPercent}%` }}
          />
        )}
        {limitFormatted && limitPercent < 100 && (
          <div
            className={`absolute top-0 h-full w-0.5 ${hasHardLimit ? "bg-destructive" : "bg-warning"}`}
            style={{ left: `${limitPercent}%` }}
          />
        )}
        <div
          className={`h-full rounded-full transition-all ${barColorClass}`}
          style={{ width: `${Math.min(currentPercent, 100)}%` }}
        />
        {isOverLimit && !hasHardLimit && data.limit && (
          <div
            className="absolute top-0 h-full animate-pulse rounded-r-full bg-danger-borderHover"
            style={{
              left: `${limitPercent}%`,
              width: `${Math.min(((data.current - data.limit) / (data.limit || 1)) * 100, 100 - limitPercent)}%`,
            }}
          />
        )}
      </div>

      {statusMessage && (
        <p
          className={`flex items-center gap-1 text-xs ${
            statusType === "error"
              ? "text-danger-borderHover"
              : statusType === "warning"
                ? "text-warning-borderHover"
                : "text-danger-borderHover"
          }`}
        >
          {statusType === "error" && <Ban className="h-3 w-3" />}
          {statusType === "warning" && <AlertTriangle className="h-3 w-3" />}
          {statusMessage}
        </p>
      )}
    </div>
  )
}
