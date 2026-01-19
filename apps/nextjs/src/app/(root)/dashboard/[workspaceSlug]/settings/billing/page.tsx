import { getSession } from "@unprice/auth/server-rsc"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { AlertCircle } from "lucide-react"
import { Fragment } from "react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { unprice } from "#utils/unprice"
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
      <Fragment>
        <UsageCard customerId={customerId} workspaceSlug={workspaceSlug} />
      </Fragment>
    </DashboardShell>
  )
}

async function UsageCard({
  customerId,
  workspaceSlug,
}: { customerId: string; workspaceSlug: string }) {
  const { result: usageData, error } = await unprice.customers.getUsage(customerId)

  if (error) {
    return (
      <Alert variant="info">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error fetching data</AlertTitle>
        <AlertDescription>{error?.message}</AlertDescription>
      </Alert>
    )
  }

  if (!usageData)
    return (
      <Alert variant="info">
        <AlertTitle>No Usage Data</AlertTitle>
        <AlertDescription>You don't have any usage data for this subscription.</AlertDescription>
      </Alert>
    )

  return <UsageDashboard config={usageData} customerId={customerId} workspaceSlug={workspaceSlug} />
}
