import { prepareInterval } from "@unprice/analytics"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import { FeaturesStats, FeaturesStatsSkeleton } from "./_components/features-stats"
import OverviewStats, { OverviewStatsSkeleton } from "./_components/overview-stats"
import TabsDashboard from "./_components/tabs-dashboard"

export const dynamic = "force-dynamic"

export default async function DashboardOverview(props: {
  params: { workspaceSlug: string; projectSlug: string }
  searchParams: SearchParams
}) {
  const { projectSlug, workspaceSlug } = props.params
  const baseUrl = `/${workspaceSlug}/${projectSlug}`
  const filter = intervalParams(props.searchParams)
  const interval = prepareInterval(filter.intervalFilter)

  batchPrefetch([
    trpc.analytics.getOverviewStats.queryOptions(
      {
        interval: filter.intervalFilter,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
    trpc.analytics.getFeaturesOverview.queryOptions(
      {
        interval_days: interval.intervalDays,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
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
        <Suspense fallback={<FeaturesStatsSkeleton isLoading={true} />}>
          <FeaturesStats />
        </Suspense>
      </HydrateClient>
    </DashboardShell>
  )
}
