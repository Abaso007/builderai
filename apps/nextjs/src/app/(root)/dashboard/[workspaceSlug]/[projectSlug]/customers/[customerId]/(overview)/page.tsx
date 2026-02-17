import { API_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Code } from "lucide-react"
import { cookies } from "next/headers"
import { notFound } from "next/navigation"
import { CodeApiSheet } from "~/components/code-api-sheet"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { unprice } from "~/lib/unprice"
import { api } from "~/trpc/server"
import { CustomerActions } from "../../_components/customers/customer-actions"
import { RealtimePanel } from "../_components/realtime/realtime-panel"

type CustomerUsageResult = NonNullable<
  Awaited<ReturnType<typeof unprice.customers.getUsage>>["result"]
>
type CustomerUsageFeature = CustomerUsageResult["groups"][number]["features"][number]

function buildRealtimeCycleUsageRows(usageData?: CustomerUsageResult | null) {
  if (!usageData) {
    return []
  }

  const rows: Array<{
    featureSlug: string
    currentUsage: number
    limitType: "hard" | "soft" | "none"
    featureType: CustomerUsageFeature["type"]
  }> = []

  for (const group of usageData.groups) {
    for (const feature of group.features) {
      if (feature.type === "usage") {
        rows.push({
          featureSlug: feature.id,
          currentUsage: feature.usageBar.current,
          limitType: feature.usageBar.limitType,
          featureType: feature.type,
        })
        continue
      }

      if (feature.type === "tiered") {
        rows.push({
          featureSlug: feature.id,
          currentUsage: feature.tieredDisplay.currentUsage,
          limitType: "none",
          featureType: feature.type,
        })
        continue
      }

      rows.push({
        featureSlug: feature.id,
        currentUsage: 0,
        limitType: "none",
        featureType: feature.type,
      })
    }
  }

  return rows
}

function formatActivePhaseBillingPeriod(interval?: string, intervalCount?: number): string | null {
  if (!interval) {
    return null
  }

  if (intervalCount && intervalCount > 1) {
    return `every ${intervalCount} ${interval}s`
  }

  switch (interval) {
    case "month":
      return "monthly"
    case "year":
      return "yearly"
    case "week":
      return "weekly"
    case "day":
      return "daily"
    case "minute":
      return "minutely"
    case "onetime":
      return "one-time"
    default:
      return interval
  }
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

  const sessionCookieName =
    process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token"
  const sessionToken = cookies().get(sessionCookieName)?.value ?? ""

  let realtimeTicket: string | null = null
  let realtimeTicketExpiresAt: number | null = null

  if (sessionToken) {
    const realtimeTicketUrl = new URL("/v1/analytics/realtime/ticket", API_DOMAIN)
    const realtimeTicketResponse = await fetch(realtimeTicketUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        customer_id: customer.id,
        project_id: customer.projectId,
        expires_in_seconds: 3600,
      }),
      cache: "no-store",
    }).catch(() => null)

    if (realtimeTicketResponse?.ok) {
      const payload = (await realtimeTicketResponse.json()) as {
        ticket?: string
        expires_at?: number
      }

      if (payload.ticket && typeof payload.expires_at === "number") {
        realtimeTicket = payload.ticket
        realtimeTicketExpiresAt = payload.expires_at
      }
    }
  }

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

  const currentPlanVersionId = currentSubscription?.phases[0]?.planVersionId

  const [
    { result: entitlementResult },
    { result: subscriptionResult },
    { result: customerUsageResult },
    currentPlanVersionResult,
  ] = await Promise.all([
    unprice.customers.getEntitlements(customer.id),
    unprice.customers.getSubscription(customer.id),
    unprice.customers.getUsage(customer.id),
    currentPlanVersionId
      ? api.planVersions.getById({ id: currentPlanVersionId }).catch(() => null)
      : Promise.resolve(null),
  ])

  const currentPlanVersion = currentPlanVersionResult?.planVersion ?? null

  const entitlementSlugs = entitlementResult?.map((entitlement) => entitlement.featureSlug) ?? []
  const cycleFeatureUsageRows = buildRealtimeCycleUsageRows(customerUsageResult)

  const activePhaseBillingPeriod = formatActivePhaseBillingPeriod(
    subscriptionResult?.activePhase?.planVersion.billingConfig.billingInterval,
    subscriptionResult?.activePhase?.planVersion.billingConfig.billingIntervalCount
  )

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
        realtimeTicket={realtimeTicket}
        realtimeTicketExpiresAt={realtimeTicketExpiresAt}
        runtimeEnv={process.env.NEXT_PUBLIC_APP_ENV ?? "development"}
        currentPlanSlug={currentSubscription?.planSlug ?? null}
        currentCycleStartAt={currentSubscription?.currentCycleStartAt ?? null}
        currentCycleEndAt={currentSubscription?.currentCycleEndAt ?? null}
        cycleTimezone={currentSubscription?.timezone ?? null}
        entitlementSlugs={entitlementSlugs}
        cycleFeatureUsageRows={cycleFeatureUsageRows}
        currentPhaseBillingPeriod={activePhaseBillingPeriod}
        planVersionFeatures={currentPlanVersion?.planFeatures ?? []}
      />
    </DashboardShell>
  )
}
