"use client"

import { APP_DOMAIN } from "@unprice/config"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { ChevronDown, ChevronUp } from "lucide-react"
import { useState } from "react"
import { PaymentMethodButton } from "~/components/forms/payment-method-form"
import type { unprice } from "~/lib/unprice"
import { FeatureGroupCard } from "./feature-card-group"
import { PriceSummary } from "./price-summary"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>

interface UsageDashboardProps {
  config: UsageConfig
  customerId: string
  workspaceSlug: string
}

export function UsageDashboard({ config, customerId, workspaceSlug }: UsageDashboardProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(config.groups.map((g) => g.id))
  )
  const [showAllGroups, setShowAllGroups] = useState(false)

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  const totalFeatures = config.groups.reduce((acc, g) => acc + g.featureCount, 0)
  const visibleGroups = showAllGroups ? config.groups : config.groups.slice(0, 3)
  const hiddenGroupsCount = config.groups.length - 3

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage & Billing</CardTitle>
        <CardDescription>
          Monitor your usage and estimated costs across all features
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Plan Overview + Price Summary */}
        <div className="mb-8 grid gap-6 lg:grid-cols-3">
          <div className="flex flex-col justify-between gap-4 lg:col-span-2">
            <div className="rounded-lg border border-border bg-card p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium text-foreground text-lg">{config.planName}</h2>
                    <Badge className="ml-2" variant="primary">
                      {config.billingPeriodLabel}
                    </Badge>
                  </div>
                  {config.planDescription && (
                    <p className="mt-1 text-muted-foreground text-sm">{config.planDescription}</p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-muted-foreground text-sm">Base price</p>
                  <p className="font-semibold text-foreground text-xl">
                    {config.priceSummary.flatTotal}
                    <span className="font-normal text-muted-foreground text-sm">
                      /{config.billingPeriodLabel}
                    </span>
                  </p>
                </div>
              </div>
              {config.renewalDate && (
                <p className="mt-4 text-muted-foreground text-sm">
                  Billing period renews on{" "}
                  <span className="text-foreground">{config.renewalDate}</span>
                  {config.daysRemaining !== undefined && config.daysRemaining > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({config.daysRemaining} days remaining)
                    </span>
                  )}
                </p>
              )}
            </div>
            <div className="flex justify-end">
              <PaymentMethodButton
                customerId={customerId}
                successUrl={`${APP_DOMAIN}/${workspaceSlug}/settings/billing`}
                cancelUrl={`${APP_DOMAIN}/${workspaceSlug}/settings/billing`}
                paymentProvider="stripe"
              />
            </div>
          </div>
          <PriceSummary data={config.priceSummary} />
        </div>

        {/* Feature Groups */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-foreground text-lg">Features ({totalFeatures})</h2>
            {config.groups.length > 3 && (
              <button
                type="button"
                onClick={() => setShowAllGroups(!showAllGroups)}
                className="flex items-center gap-1 font-medium text-sm transition-colors"
              >
                {showAllGroups ? "Show less" : `Show all ${config.groups.length} groups`}
                {showAllGroups ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
            )}
          </div>

          {visibleGroups.map((group) => (
            <FeatureGroupCard
              key={group.id}
              group={group}
              isExpanded={expandedGroups.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
              planBillingPeriodLabel={config.billingPeriodLabel}
            />
          ))}

          {!showAllGroups && hiddenGroupsCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllGroups(true)}
              className="w-full rounded-lg border border-border border-dashed bg-card/50 p-4 text-muted-foreground text-sm transition-colors hover:bg-card hover:text-foreground"
            >
              +{hiddenGroupsCount} more group{hiddenGroupsCount > 1 ? "s" : ""}
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
