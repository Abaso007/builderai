import { IntervalFilter } from "~/components/analytics/interval-filter"
import { LakehouseDashboardSqlrooms } from "~/components/lakehouse/lakehouse-dashboard-sqlrooms"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"

export default async function LakehousePage() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Analytics Console"
          description="Explore your data with SQL"
          action={<IntervalFilter className="ml-auto" />}
        />
      }
    >
      <LakehouseDashboardSqlrooms />
    </DashboardShell>
  )
}
