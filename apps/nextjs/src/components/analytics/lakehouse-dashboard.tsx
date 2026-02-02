import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { useState } from "react"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useLakehouse } from "~/hooks/use-lakehouse"
import { useTRPC } from "~/trpc/client"

export function LakehouseDashboard() {
  const [interval] = useIntervalFilter()
  const { start, end } = interval

  const trpc = useTRPC()
  const { status, error, runQuery } = useLakehouse()
  const [results, setResults] = useState<any[]>([])

  // Fetch URLs using tRPC
  const { data: urls, isLoading: isLoadingUrls } = trpc.analytics.getLakehouseUrls.useQuery(
    {
      from: start,
      to: end,
    },
    {
      enabled: !!start && !!end,
      staleTime: 1000 * 60 * 5, // 5 minutes
    }
  )

  const handleRun = async () => {
    if (!urls) return
    try {
      const res = await runQuery(urls)
      setResults(res)
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Lakehouse Analytics (POC)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center gap-4">
            <div className="text-sm text-muted-foreground">
              Status: <span className="font-medium text-foreground">{status}</span>
            </div>
            <Button
              onClick={handleRun}
              disabled={status === "running" || status === "initializing" || isLoadingUrls || !urls}
            >
              {isLoadingUrls ? "Fetching URLs..." : "Run Analysis"}
            </Button>
          </div>

          {error && <div className="mb-4 text-red-500">{error}</div>}

          {urls && (
            <div className="mb-4 text-xs text-muted-foreground">
              Found {urls.usage.length} usage files, {urls.verifications.length} verification files,{" "}
              {urls.metadata.length} metadata files.
            </div>
          )}

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Country</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="h-24 text-center">
                      No results. Click "Run Analysis" to start.
                    </TableCell>
                  </TableRow>
                ) : (
                  results.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>{row.country || "Unknown"}</TableCell>
                      <TableCell className="text-right">
                        {row.total_cost != null ? `$${row.total_cost.toFixed(4)}` : "-"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
