import { Button } from "@unprice/ui/button"
import { Separator } from "@unprice/ui/separator"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"
import { Code, Plus } from "lucide-react"
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
              <div className="button-primary flex items-center space-x-1 rounded-md">
                <div className="sm:col-span-full">
                  <SuperLink href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/new`}>
                    <Button variant={"custom"}>
                      <Plus className="mr-2 h-4 w-4" />
                      Subscription
                    </Button>
                  </SuperLink>
                </div>

                <Separator orientation="vertical" className="h-[20px] p-0" />

                <CustomerActions customer={customer} />
              </div>
            </div>
          }
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/invoices`}>Invoices</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink active asChild>
            <SuperLink href={`${baseUrl}/usage`}>Usage</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>

      <div className="mt-4 space-y-4">
        <div className="flex flex-col px-1 py-2">
          <Typography variant="p" affects="removePaddingMargin">
            Live usage and verification metrics from Durable Object aggregates
          </Typography>
        </div>

        <RealtimePanel
          customerId={customer.id}
          projectId={customer.projectId}
          sessionToken={sessionToken}
          runtimeEnv={process.env.NODE_ENV ?? "development"}
        />
      </div>
    </DashboardShell>
  )
}
