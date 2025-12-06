"use client"

import { formatMoney } from "@unprice/db/utils"
import { Badge } from "@unprice/ui/badge"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { unprice } from "~/lib/unprice"
import { FeatureItem } from "./feature-item"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>
type FeatureGroupDisplay = UsageConfig["groups"][number]

interface FeatureGroupCardProps {
  group: FeatureGroupDisplay
  isExpanded: boolean
  onToggle: () => void
  currency?: string
}

export function FeatureGroupCard({
  group,
  isExpanded,
  onToggle,
  currency = "USD",
}: FeatureGroupCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        onClick={onToggle}
        type="button"
        className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-secondary/50"
      >
        <div className="flex items-center gap-3">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-medium text-foreground">{group.name}</span>
          <Badge className="ml-2">
            {group.featureCount} feature{group.featureCount !== 1 ? "s" : ""}
          </Badge>
        </div>
        {group.totalPrice > 0 && (
          <span className="font-medium text-background-textContrast text-sm">
            {formatMoney(group.totalPrice.toString(), currency)}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="divide-y divide-border border-border border-t">
          {group.features.map((feature) => (
            <FeatureItem key={feature.id} feature={feature} />
          ))}
        </div>
      )}
    </div>
  )
}
