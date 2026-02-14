import { prepareInterval } from "@unprice/analytics"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { IntervalFilter } from "~/components/analytics/interval-filter"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { intervalParams } from "~/lib/searchParams"
import { HydrateClient, batchPrefetch, trpc } from "~/trpc/server"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"
import {
  ProjectLatencyPanel,
  ProjectLatencyPanelSkeleton,
} from "../_components/project-latency-panel"
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
    trpc.analytics.getFeaturesOverview.queryOptions(
      {
        interval_days: interval.intervalDays,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
    trpc.analytics.getVerifications.queryOptions(
      {
        interval_days: interval.intervalDays,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
      }
    ),
    trpc.analytics.getVerificationRegions.queryOptions(
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
        <TabsDashboard baseUrl={baseUrl} activeTab="latency" />
        <IntervalFilter className="ml-auto" />
      </div>

      <HydrateClient>
        <Suspense fallback={<ProjectLatencyPanelSkeleton />}>
          <ProjectLatencyPanel />
        </Suspense>
      </HydrateClient>
    </DashboardShell>
  )
}
