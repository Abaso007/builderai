import { prepareInterval } from "@unprice/analytics"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_STALE_TIME } from "~/trpc/shared"
import { LatencyTable, LatencyTableSkeleton } from "../_components/latency-table"
import TabsDashboard from "../_components/tabs-dashboard"

export const dynamic = "force-dynamic"

export default async function DashboardLatency(props: {
  params: { workspaceSlug: string; projectSlug: string }
  searchParams: SearchParams
}) {
  const { projectSlug, workspaceSlug } = props.params
  const baseUrl = `/${workspaceSlug}/${projectSlug}`

  const filter = intervalParams(props.searchParams)
  const interval = prepareInterval(filter.intervalFilter)

  batchPrefetch([
    trpc.analytics.getVerificationRegions.queryOptions(
      {
        intervalDays: interval.intervalDays,
      },
      {
        staleTime: ANALYTICS_STALE_TIME,
      }
    ),
  ])

  return (
    <DashboardShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <TabsDashboard baseUrl={baseUrl} activeTab="latency" />
        <IntervalFilter className="ml-auto" />
      </div>

      <HydrateClient>
        <Suspense fallback={<LatencyTableSkeleton />}>
          <LatencyTable />
        </Suspense>
        {/* <Suspense
          fallback={
            <FeatureUsageHeatmap>
              <FeatureUsageHeatmapSkeleton isLoading={true} />
            </FeatureUsageHeatmap>
          }
        >
          <FeatureUsageHeatmap>
            <FeatureUsageHeatmapContent />
          </FeatureUsageHeatmap>
        </Suspense> */}
      </HydrateClient>
    </DashboardShell>
  )
}
