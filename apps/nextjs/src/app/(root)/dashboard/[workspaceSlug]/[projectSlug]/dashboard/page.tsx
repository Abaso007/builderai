import { prepareInterval } from "@unprice/analytics"
import { FEATURE_SLUGS } from "@unprice/config"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { AnalyticsCard } from "~/components/analytics/analytics-card"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { UsageChart } from "~/components/analytics/usage-chart"
import { VerificationsChart } from "~/components/analytics/verifications-chart"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { entitlementFlag } from "~/lib/flags"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_STALE_TIME } from "~/trpc/shared"
import OverviewStats, { OverviewStatsSkeleton } from "./_components/overview-stats"
import { PageVisits, PageVisitsSkeleton } from "./_components/page-visits"
import { PlansConversion, PlansConversionSkeleton } from "./_components/plans-convertion"
import TabsDashboard from "./_components/tabs-dashboard"

export const dynamic = "force-dynamic"

export default async function DashboardOverview(props: {
  params: { workspaceSlug: string; projectSlug: string }
  searchParams: SearchParams
}) {
  const { projectSlug, workspaceSlug } = props.params
  const baseUrl = `/${workspaceSlug}/${projectSlug}`
  const isPagesEnabled = await entitlementFlag(FEATURE_SLUGS.PAGES.SLUG)
  const filter = intervalParams(props.searchParams)
  const interval = prepareInterval(filter.intervalFilter)

  batchPrefetch([
    trpc.analytics.getOverviewStats.queryOptions(
      {
        interval: filter.intervalFilter,
      },
      {
        staleTime: ANALYTICS_STALE_TIME,
      }
    ),
    trpc.analytics.getVerifications.queryOptions(
      {
        interval_days: interval.intervalDays,
      },
      {
        staleTime: ANALYTICS_STALE_TIME,
      }
    ),
    ...(isPagesEnabled
      ? [
          trpc.analytics.getPlansConversion.queryOptions(
            {
              interval_days: interval.intervalDays,
            },
            {
              staleTime: ANALYTICS_STALE_TIME,
            }
          ),
          trpc.analytics.getPagesOverview.queryOptions(
            {
              interval_days: interval.intervalDays,
              page_id: "all",
            },
            {
              staleTime: ANALYTICS_STALE_TIME,
            }
          ),
        ]
      : []),
  ])

  return (
    <DashboardShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <TabsDashboard baseUrl={baseUrl} activeTab="overview" />
        <IntervalFilter className="ml-auto" />
      </div>
      <HydrateClient>
        <Suspense fallback={<OverviewStatsSkeleton isLoading={true} />}>
          <OverviewStats />
        </Suspense>
        <AnalyticsCard
          className="w-full"
          title="Value Metrics"
          description="Real-time insights into how users are experiencing your product value metrics."
          defaultTab="verifications"
          tabs={[
            {
              id: "verifications",
              label: "Verifications",
              description: `Value verification events for the ${interval.label}.`,
              chart: () => <VerificationsChart />,
            },
            {
              id: "usage",
              label: "Usage",
              description: `Usage metrics for the ${interval.label}.`,
              chart: () => <UsageChart />,
            },
          ]}
        />
        {isPagesEnabled && (
          <Suspense fallback={<PageVisitsSkeleton isLoading={true} isSelected={true} />}>
            <PageVisits pageId="all" />
          </Suspense>
        )}
        {isPagesEnabled && (
          <Suspense fallback={<PlansConversionSkeleton />}>
            <PlansConversion />
          </Suspense>
        )}
      </HydrateClient>
    </DashboardShell>
  )
}
