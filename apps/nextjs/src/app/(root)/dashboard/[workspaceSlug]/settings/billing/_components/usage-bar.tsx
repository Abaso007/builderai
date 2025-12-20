"use client"

import { nFormatter } from "@unprice/db/utils"
import { Progress } from "@unprice/ui/progress"
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
  const { current, included, limit, limitType, unit } = data
  // These fields may not exist in the type yet, but will be available at runtime
  const notifyThreshold = (data as { notifyThreshold?: number }).notifyThreshold ?? 95
  const allowOverage = (data as { allowOverage?: boolean }).allowOverage ?? false

  const currentFormatted = formatNumber(current, unit)
  const limitFormatted = limit !== undefined ? formatNumber(limit, unit) : null
  const includedFormatted = formatNumber(included, unit)

  const hasHardLimit = limitType === "hard"
  const hasSoftLimit = limitType === "soft"
  const hasNoLimit = limitType === "none"

  // Calculate max value for percentage: limit > included > current*1.2 > 1
  const maxValue =
    limit !== null && limit !== undefined
      ? limit
      : included > 0
        ? included
        : current > 0
          ? Math.max(current * 1.2, current + 1)
          : 1

  const currentPercent = Math.min(100, (current / maxValue) * 100)

  // Calculate derived states
  const isOverIncluded = current > included
  const isOverLimit = limit !== null && limit !== undefined && current > limit
  const isNearLimit = limit !== null && limit !== undefined && currentPercent >= notifyThreshold

  // Determine status message
  let statusMessage: string | undefined
  let statusType: "warning" | "error" | "info" | undefined
  if (isOverLimit && !allowOverage) {
    statusMessage = "Limit exceeded"
    statusType = "error"
  } else if (isOverIncluded) {
    statusMessage = "Over included limit"
    statusType = "info"
  } else if (isNearLimit) {
    statusMessage = "Near limit"
    statusType = "warning"
  }

  // Clamp to 0-100 for Progress component (it can't show >100% natively)
  const progressValue =
    Number.isFinite(currentPercent) && currentPercent >= 0 ? Math.min(100, currentPercent) : 0

  // Determine progress variant based on state
  const progressVariant: "default" | "primary" | "destructive" | "secondary" =
    isOverLimit && hasHardLimit
      ? "destructive"
      : isOverIncluded
        ? "secondary"
        : isNearLimit
          ? "secondary"
          : "primary"

  return (
    <div className="space-y-2">
      {/* Usage Stats - Simplified */}
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-foreground text-xl">{currentFormatted}</span>
          <span className="text-muted-foreground text-sm">
            {limitFormatted
              ? `of ${limitFormatted}`
              : included > 0
                ? `of ${includedFormatted}`
                : ""}{" "}
          </span>
        </div>
        {limitFormatted && (
          <TooltipProvider>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
                    hasHardLimit
                      ? "text-destructive"
                      : hasSoftLimit
                        ? "text-warning"
                        : "text-success"
                  }`}
                >
                  {hasHardLimit && <Ban className="h-3 w-3" />}
                  {hasSoftLimit && <AlertTriangle className="h-3 w-3" />}
                  {hasNoLimit && <TrendingUp className="h-3 w-3" />}
                  {hasHardLimit ? "Hard limit" : hasSoftLimit ? "Soft limit" : "Unlimited"}
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

      <Progress value={progressValue} variant={progressVariant} className="h-2" />

      {/* Status Message - Only show when there's an issue */}
      {statusMessage && (statusType === "error" || statusType === "warning") && (
        <p
          className={`flex items-center gap-1.5 text-xs ${
            statusType === "error" ? "text-destructive" : "text-warning"
          }`}
        >
          {statusType === "error" && <Ban className="h-3.5 w-3.5" />}
          {statusType === "warning" && <AlertTriangle className="h-3.5 w-3.5" />}
          {statusMessage}
        </p>
      )}

      {/* Additional Info - Only show if there's included units */}
      {included > 0 && (
        <div className="text-muted-foreground text-xs">
          <span>{includedFormatted} included</span>
        </div>
      )}
    </div>
  )
}
