import type { RouterOutputs } from "@unprice/trpc/routes"
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
import { RealtimePanel } from "../_components/realtime/realtime-panel"

type CustomerUsageResult = NonNullable<RouterOutputs["customers"]["getUsage"]["usage"]>
type CustomerUsageFeature = CustomerUsageResult["groups"][number]["features"][number]

function buildRealtimeCycleUsageRows(usageData?: CustomerUsageResult | null) {
  if (!usageData) {
    return []
  }

  const rows: Array<{
    featureSlug: string
    currentUsage: number
    limit: number | null
    limitType: "hard" | "soft" | "none"
    featureType: CustomerUsageFeature["type"]
  }> = []

  for (const group of usageData.groups) {
    for (const feature of group.features) {
      if (feature.type === "usage") {
        const limit =
          typeof feature.usageBar.limit === "number" && feature.usageBar.limit > 0
            ? feature.usageBar.limit
            : null
        rows.push({
          featureSlug: feature.id,
          currentUsage: feature.usageBar.current,
          limit,
          limitType: feature.usageBar.limitType,
          featureType: feature.type,
        })
        continue
      }

      if (feature.type === "tiered") {
        const tieredMax = feature.tieredDisplay.tiers.find((t) => t.isActive)?.max
        const limit =
          typeof tieredMax === "number" && tieredMax > 0 ? tieredMax : null
        rows.push({
          featureSlug: feature.id,
          currentUsage: feature.tieredDisplay.currentUsage,
          limit,
          limitType: "none",
          featureType: feature.type,
        })
        continue
      }

      rows.push({
        featureSlug: feature.id,
        currentUsage: 0,
        limit: null,
        limitType: "none",
        featureType: feature.type,
      })
    }
  }

  return rows
}

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

  const realtimeTicket = await api.analytics.getRealtimeTicket({
    customerId,
  })

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

  const [
    { entitlements: entitlementResult },
    { subscription: subscriptionResult },
    { usage: customerUsageResult },
  ] = await Promise.all([
    api.customers.getEntitlements({ customerId: customer.id }),
    api.customers.getSubscription({ customerId: customer.id }),
    api.customers.getUsage({ customerId: customer.id }),
  ])

  const currentPhase = subscriptionResult?.activePhase ?? null
  const entitlementSlugs = entitlementResult?.map((entitlement) => entitlement.featureSlug) ?? []
  const cycleFeatureUsageRows = buildRealtimeCycleUsageRows(customerUsageResult)

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

      <RealtimePanel
        customerId={customer.id}
        projectId={customer.projectId}
        realtimeTicket={realtimeTicket.ticket}
        realtimeTicketExpiresAt={realtimeTicket.expiresAt}
        runtimeEnv={process.env.NEXT_PUBLIC_APP_ENV ?? "development"}
        currentPlanSlug={currentSubscription?.planSlug ?? null}
        currentCycleStartAt={currentSubscription?.currentCycleStartAt ?? null}
        currentCycleEndAt={currentSubscription?.currentCycleEndAt ?? null}
        cycleTimezone={currentSubscription?.timezone ?? null}
        entitlementSlugs={currentPhase ? entitlementSlugs : []}
        cycleFeatureUsageRows={cycleFeatureUsageRows}
        currentPhaseBillingPeriod={
          currentPhase?.planVersion?.billingConfig.billingInterval ?? "No active phase"
        }
      />
    </DashboardShell>
  )
}
