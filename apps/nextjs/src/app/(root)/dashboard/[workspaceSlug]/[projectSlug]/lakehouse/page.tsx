import { IntervalFilter } from "~/components/analytics/interval-filter"
import { LakehouseDashboardSqlrooms } from "~/components/lakehouse/lakehouse-dashboard-sqlrooms"
import { DashboardShell } from "~/components/layout/dashboard-shell"

export default async function LakehousePage() {
  return (
    <DashboardShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <h1 className="font-bold text-2xl">Lakehouse Analytics</h1>
        <IntervalFilter className="ml-auto" />
      </div>
      <LakehouseDashboardSqlrooms />
    </DashboardShell>
  )
}
