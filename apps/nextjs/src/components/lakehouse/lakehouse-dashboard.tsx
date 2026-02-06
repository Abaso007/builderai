"use client"

import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { useEffect, useState } from "react"
import { useUsageDuckdb } from "~/hooks/use-usage-duckdb"

export function LakehouseDashboard() {
  const { isReady, isLoading, runCustomQuery, loadedFileCount, totalEvents, error } =
    useUsageDuckdb("alksjda")
  const [results, setResults] = useState<{ country: string; total_usage: number }[]>([])
  const [isQuerying, setIsQuerying] = useState(false)

  const runAnalysis = async () => {
    setIsQuerying(true)
    try {
      const res = await runCustomQuery(
        "SELECT country, SUM(usage) as total_usage FROM usage_events GROUP BY country ORDER BY total_usage DESC"
      )
      if (res) {
        setResults(res.rows as { country: string; total_usage: number }[])
      }
    } catch (e) {
      console.error(e)
    } finally {
      setIsQuerying(false)
    }
  }

  // Automatically run analysis when data is ready
  useEffect(() => {
    if (isReady) {
      void runAnalysis()
    } else {
      setResults([])
    }
  }, [isReady, runCustomQuery])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Lakehouse Analytics (POC)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center gap-4">
            <div className="text-muted-foreground text-sm">
              Status:{" "}
              <span className="font-medium text-foreground">
                {isLoading
                  ? "Loading data..."
                  : isQuerying
                    ? "Querying..."
                    : isReady
                      ? "Ready"
                      : "Idle"}
              </span>
            </div>
            <Button onClick={runAnalysis} disabled={!isReady || isLoading || isQuerying} size="sm">
              Reload Analysis
            </Button>
          </div>

          {error && <div className="mb-4 text-red-500">{error}</div>}

          {isReady && (
            <div className="mb-4 text-muted-foreground text-xs">
              Loaded {loadedFileCount} files, {totalEvents} events.
            </div>
          )}

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Country</TableHead>
                  <TableHead className="text-right">Total Usage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="h-24 text-center">
                      {isLoading || isQuerying
                        ? "Processing..."
                        : "No results. Data might be empty."}
                    </TableCell>
                  </TableRow>
                ) : (
                  results.map((row, i) => (
                    <TableRow key={i.toString()}>
                      <TableCell>{row.country || "Unknown"}</TableCell>
                      <TableCell className="text-right">
                        {row.total_usage != null ? row.total_usage.toLocaleString() : "-"}
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
