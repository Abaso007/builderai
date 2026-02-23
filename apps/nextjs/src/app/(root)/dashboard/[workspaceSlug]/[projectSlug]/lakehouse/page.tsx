import { IntervalFilter } from "~/components/analytics/interval-filter"
import { LakehouseDashboardSqlrooms } from "~/components/lakehouse/lakehouse-dashboard"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"

export default async function LakehousePage({
  params,
}: {
  params: { workspaceSlug: string; projectSlug: string }
}) {
  const routeScopeKey = `${params.workspaceSlug}:${params.projectSlug}`

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Analytics Console"
          description="Explore your data with SQL. Historical analytics synced from the data lake."
          action={<IntervalFilter className="ml-auto" />}
        />
      }
    >
      <LakehouseDashboardSqlrooms key={routeScopeKey} />
    </DashboardShell>
  )
}
