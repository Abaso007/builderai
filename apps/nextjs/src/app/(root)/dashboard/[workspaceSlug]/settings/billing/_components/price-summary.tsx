"use client"

import { formatMoney } from "@unprice/db/utils"
import { TrendingUp } from "lucide-react"
import type { unprice } from "~/lib/unprice"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>
type PriceSummaryDisplay = UsageConfig["priceSummary"]

interface PriceSummaryProps {
  data: PriceSummaryDisplay
  currency: string
}

export function PriceSummary({ data, currency }: PriceSummaryProps) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-6">
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <TrendingUp className="h-4 w-4" />
        <span>Estimated this period</span>
      </div>
      <p className="mt-2 font-bold text-3xl text-foreground">
        {formatMoney(data.totalPrice.toString(), currency)}
      </p>

      {data.hasUsageCharges && (
        <div className="mt-4 space-y-2 border-border border-t pt-4">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Base plan</span>
            <span className="text-foreground">
              {formatMoney(data.basePrice.toString(), currency)}
            </span>
          </div>
          {data.flatTotal > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Add-ons</span>
              <span className="text-foreground">
                {formatMoney(data.flatTotal.toString(), currency)}
              </span>
            </div>
          )}
          {data.tieredTotal > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Tiered usage</span>
              <span className="text-foreground">
                {formatMoney(data.tieredTotal.toString(), currency)}
              </span>
            </div>
          )}
          {data.usageTotal > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Usage overage</span>
              <span className="text-chart-5">
                {formatMoney(data.usageTotal.toString(), currency)}
              </span>
            </div>
          )}
          {data.hasFreeGrantsSavings && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Free grants savings</span>
              <span className="text-success">
                -{formatMoney(data.freeGrantsSavings.toString(), currency)}
              </span>
            </div>
          )}
        </div>
      )}

      <p className="mt-4 text-muted text-xs">
        Final invoice may vary based on actual usage at billing date
      </p>
    </div>
  )
}
