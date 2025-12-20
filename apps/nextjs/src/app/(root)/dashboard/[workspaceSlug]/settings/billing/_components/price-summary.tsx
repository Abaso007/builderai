"use client"

import type { unprice } from "~/lib/unprice"

type UsageConfig = NonNullable<Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]>
type PriceSummaryDisplay = UsageConfig["priceSummary"]

interface PriceSummaryProps {
  data: PriceSummaryDisplay
}

export function PriceSummary({ data }: PriceSummaryProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="text-muted-foreground text-sm">Estimated this period</div>
      <p className="mt-1 font-bold text-3xl text-foreground">{data.totalPrice}</p>

      <div className="mt-6 space-y-2.5 border-border border-t pt-4">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Fixed price</span>
          <span className="font-medium text-foreground">{data.flatTotal}</span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Tiered usage</span>
          <span className="font-medium text-foreground">{data.tieredTotal}</span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Package usage</span>
          <span className="font-medium text-foreground">{data.packageTotal}</span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Usage charges</span>
          <span className="font-medium text-foreground">{data.usageTotal}</span>
        </div>
      </div>

      <p className="mt-4 text-muted-foreground text-xs">
        Final invoice may vary based on actual usage
      </p>
    </div>
  )
}
