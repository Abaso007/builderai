import { IntervalFilter } from "~/components/analytics/interval-filter"
import { LakehouseDashboard } from "~/components/analytics/lakehouse-dashboard"
import { DashboardShell } from "~/components/layout/dashboard-shell"

export default function LakehousePage() {
  return (
    <DashboardShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl font-bold">Lakehouse Analytics</h1>
        <IntervalFilter className="ml-auto" />
      </div>
      <LakehouseDashboard />
    </DashboardShell>
  )
}
