import { LakehouseDashboardSqlrooms } from "~/components/lakehouse/lakehouse-dashboard"
import { DashboardShell } from "~/components/layout/dashboard-shell"

export default async function LakehousePage({
  params,
}: {
  params: { workspaceSlug: string; projectSlug: string }
}) {
  const routeScopeKey = `${params.workspaceSlug}:${params.projectSlug}`

  return (
    <DashboardShell>
      <LakehouseDashboardSqlrooms key={routeScopeKey} />
    </DashboardShell>
  )
}
