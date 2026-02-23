import { useSql } from "@sqlrooms/duckdb"
import { useCallback, useMemo } from "react"
import {
  type LakehouseTrendBucket,
  type LakehouseTrendInterval,
  METADATA_COVERAGE_QUERY,
  USAGE_SUMMARY_QUERY,
  VERIFICATION_SUMMARY_QUERY,
  getLakehouseTrendBucket,
  getUsageTrendQuery,
  getVerificationTrendQuery,
} from "./lakehouse-constants"

interface Options {
  hasUsage: boolean
  hasVerification: boolean
  hasMetadata: boolean
  intervalName: LakehouseTrendInterval
}

const toNumber = (v: unknown): number => {
  if (typeof v === "bigint") return Number(v)
  if (v == null) return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
const tableToRows = (table?: { toArray?: () => any[] } | null) => table?.toArray?.() ?? []

export function useLakehouseAnalytics({
  hasUsage,
  hasVerification,
  hasMetadata,
  intervalName,
}: Options) {
  const trendBucket: LakehouseTrendBucket = useMemo(
    () => getLakehouseTrendBucket(intervalName),
    [intervalName]
  )

  const usageSummary = useSql({ query: USAGE_SUMMARY_QUERY, enabled: hasUsage })
  const verificationSummary = useSql({
    query: VERIFICATION_SUMMARY_QUERY,
    enabled: hasVerification,
  })
  const metadataCoverage = useSql({
    query: METADATA_COVERAGE_QUERY,
    enabled: hasUsage && hasMetadata,
  })
  const usageTrend = useSql({
    query: getUsageTrendQuery(intervalName),
    enabled: hasUsage,
  })
  const verificationTrend = useSql({
    query: getVerificationTrendQuery(intervalName),
    enabled: hasVerification,
  })

  const usageSummaryRow = useMemo(
    () => tableToRows(usageSummary.data?.arrowTable)[0],
    [usageSummary.data]
  )
  const verificationSummaryRow = useMemo(
    () => tableToRows(verificationSummary.data?.arrowTable)[0],
    [verificationSummary.data]
  )
  const metadataCoverageRow = useMemo(
    () => tableToRows(metadataCoverage.data?.arrowTable)[0],
    [metadataCoverage.data]
  )

  const usageTrendData = useMemo(
    () =>
      tableToRows(usageTrend.data?.arrowTable).map((row) => ({
        ...row,
        events: toNumber(row.events),
        total_usage: toNumber(row.total_usage),
      })),
    [usageTrend.data]
  )

  const verificationTrendData = useMemo(
    () =>
      tableToRows(verificationTrend.data?.arrowTable).map((row) => ({
        ...row,
        allowed: toNumber(row.allowed),
        denied: toNumber(row.denied),
      })),
    [verificationTrend.data]
  )

  const metadataCoveragePct = useMemo(() => {
    if (!hasMetadata) return null
    const total = toNumber(metadataCoverageRow?.total)
    const withMeta = toNumber(metadataCoverageRow?.with_meta)
    return total ? (withMeta / total) * 100 : 0
  }, [metadataCoverageRow, hasMetadata])

  const verificationPassRate = useMemo(() => {
    if (!hasVerification) return null
    const total = toNumber(verificationSummaryRow?.total)
    const allowed = toNumber(verificationSummaryRow?.allowed)
    return total ? (allowed / total) * 100 : 0
  }, [verificationSummaryRow, hasVerification])

  const isSameDay = useCallback((data: Array<{ bucket?: string }>) => {
    if (data.length < 2) return false
    return data[0]?.bucket?.slice(0, 10) === data[data.length - 1]?.bucket?.slice(0, 10)
  }, [])

  return {
    usageSummaryRow,
    verificationSummaryRow,
    metadataCoverageRow,
    usageTrendData,
    verificationTrendData,
    metadataCoveragePct,
    verificationPassRate,
    trendBucket,
    usageSameDay: isSameDay(usageTrendData),
    verificationSameDay: isSameDay(verificationTrendData),
  }
}
