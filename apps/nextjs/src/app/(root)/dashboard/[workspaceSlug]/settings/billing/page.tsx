import { getSession } from "@unprice/auth/server-rsc"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { AlertCircle } from "lucide-react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { api } from "~/trpc/server"
import { UsageDashboard } from "./_components/usage-dashboard"

export default async function BillingPage({ params }: { params: { workspaceSlug: string } }) {
  const { workspaceSlug } = params
  const session = await getSession()
  const atw = session?.user.workspaces.find((w) => w.slug === workspaceSlug)
  const isMainWorkspace = atw?.isMain
  const customerId = atw?.unPriceCustomerId ?? ""

  if (isMainWorkspace) {
    return (
      <DashboardShell
        header={
          <HeaderTab
            title="Scale & Usage"
            description="Observe the growth and value metrics of this workspace."
          />
        }
      >
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Main Workspace</AlertTitle>
          <AlertDescription>
            This is the main workspace, where your foundation is established. No further billing
            management is required here.
          </AlertDescription>
        </Alert>
      </DashboardShell>
    )
  }

  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Scale & Usage"
          description="Observe and manage your workspace value flows."
        />
      }
    >
      <UsageCard customerId={customerId} workspaceSlug={workspaceSlug} />
    </DashboardShell>
  )
}

async function UsageCard({
  customerId,
  workspaceSlug,
}: { customerId: string; workspaceSlug: string }) {
  if (!customerId) {
    return (
      <Alert variant="info">
        <AlertTitle>No Customer Context</AlertTitle>
        <AlertDescription>This workspace has no billing customer configured yet.</AlertDescription>
      </Alert>
    )
  }

  try {
    const usageData = await api.analytics.getUsage({
      customerId: customerId,
      range: "30d",
    })

    if (usageData.error) {
      return (
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error fetching usage data</AlertTitle>
          <AlertDescription>{usageData.error}</AlertDescription>
        </Alert>
      )
    }

    if (!usageData.usage || usageData.usage.length === 0) {
      return (
        <Alert variant="info">
          <AlertTitle>No Usage Data</AlertTitle>
          <AlertDescription>No usage was reported in the last 30 days.</AlertDescription>
        </Alert>
      )
    }

    return (
      <UsageDashboard
        usageRows={usageData.usage}
        customerId={customerId}
        workspaceSlug={workspaceSlug}
      />
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while loading usage"
    return (
      <Alert variant="info">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error fetching usage data</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }
}
