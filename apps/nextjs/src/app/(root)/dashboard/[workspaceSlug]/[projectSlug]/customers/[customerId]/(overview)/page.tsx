import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Code } from "lucide-react"
import { notFound } from "next/navigation"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { api } from "~/trpc/server"
import { CustomerActions } from "../../_components/customers/customer-actions"
import { CustomerMetricsPanel } from "../_components/usage/customer-metrics-panel"

export default async function CustomerUsagePage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
}) {
  const { workspaceSlug, projectSlug, customerId } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`

  const { customer } = await api.customers.getSubscriptions({
    customerId,
  })

  if (!customer) {
    notFound()
  }

  const usageSnapshot = await api.analytics
    .getUsage({
      customerId,
      range: "30d",
    })
    .catch((error) => ({
      usage: [],
      error: error instanceof Error ? error.message : "Failed to load usage metrics",
    }))

  return (
    <DashboardShell
      header={
        <HeaderTab
          title={customer.email}
          description={customer.description}
          label={customer.active ? "active" : "inactive"}
          id={customer.id}
          action={
            <div className="flex items-center gap-2">
              <CodeApiSheet defaultMethod="getUsage">
                <Button variant={"ghost"}>
                  <Code className="mr-2 h-4 w-4" />
                  API
                </Button>
              </CodeApiSheet>
              <CustomerActions customer={customer} />
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}`}>Overview</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/invoices`}>Invoices</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>

      <CustomerMetricsPanel usageRows={usageSnapshot.usage ?? []} error={usageSnapshot.error} />
    </DashboardShell>
  )
}
