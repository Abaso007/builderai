import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Code } from "lucide-react"
import { cookies } from "next/headers"
import { notFound } from "next/navigation"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { api } from "~/trpc/server"
import { CustomerActions } from "../../_components/customers/customer-actions"
import { RealtimePanel } from "../_components/realtime/realtime-panel"

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

  const sessionCookieName =
    process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token"
  const sessionToken = cookies().get(sessionCookieName)?.value ?? ""

  const currentSubscription =
    [...customer.subscriptions]
      .filter((subscription) => subscription.active)
      .sort(
        (a, b) =>
          (b.currentCycleStartAt ?? b.createdAtM ?? 0) -
          (a.currentCycleStartAt ?? a.createdAtM ?? 0)
      )[0] ??
    [...customer.subscriptions].sort(
      (a, b) =>
        (b.currentCycleStartAt ?? b.createdAtM ?? 0) - (a.currentCycleStartAt ?? a.createdAtM ?? 0)
    )[0]

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
              <CodeApiSheet defaultMethod="getEntitlements">
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

      <div className="mt-4 space-y-4">
        <RealtimePanel
          customerId={customer.id}
          projectId={customer.projectId}
          sessionToken={sessionToken}
          runtimeEnv={process.env.NODE_ENV ?? "development"}
          currentPlanSlug={currentSubscription?.planSlug ?? null}
          currentCycleStartAt={currentSubscription?.currentCycleStartAt ?? null}
          currentCycleEndAt={currentSubscription?.currentCycleEndAt ?? null}
          cycleTimezone={currentSubscription?.timezone ?? null}
        />
      </div>
    </DashboardShell>
  )
}
