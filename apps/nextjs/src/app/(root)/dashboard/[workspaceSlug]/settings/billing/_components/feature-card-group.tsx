"use client"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { unprice } from "~/lib/unprice"
import { FeatureItem } from "./feature-item"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>
type FeatureGroupDisplay = UsageConfig["groups"][number]

interface FeatureGroupCardProps {
  group: FeatureGroupDisplay
  isExpanded: boolean
  onToggle: () => void
  planBillingPeriodLabel: string
}

export function FeatureGroupCard({
  group,
  isExpanded,
  onToggle,
  planBillingPeriodLabel,
}: FeatureGroupCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        onClick={onToggle}
        type="button"
        className="flex w-full items-center justify-between p-3 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex items-center gap-3">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-medium text-foreground">{group.name}</span>
          <span className="text-muted-foreground text-sm">
            {group.featureCount} {group.featureCount === 1 ? "feature" : "features"}
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="divide-y divide-border border-t">
          {group.features.map((feature) => (
            <FeatureItem
              key={feature.id}
              feature={feature}
              planBillingPeriodLabel={planBillingPeriodLabel}
            />
          ))}
        </div>
      )}
    </div>
  )
}
