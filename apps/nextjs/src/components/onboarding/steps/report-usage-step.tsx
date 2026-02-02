import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { useQuery } from "@tanstack/react-query"
import { API_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"
import { Activity, Check, Copy, Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

export function ReportUsageStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, next } = useOnboarding()
  const [isLoading, setIsLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [usageAmount, setUsageAmount] = useState<string>("10")
  const [selectedFeature, setSelectedFeature] = useState<string>("")
  const [activeTab, setActiveTab] = useState("ui")

  const apiKey = (state?.context?.flowData as { apiKey?: string })?.apiKey || ""
  const planVersionId =
    (state?.context?.flowData as { planVersionId?: string })?.planVersionId || ""
  const projectSlug = (state?.context?.flowData as { project?: { slug: string } })?.project?.slug
  const customerId =
    (state?.context?.flowData as { customer?: { customerId: string } })?.customer?.customerId || ""

  const trpc = useTRPC()

  const { data: planVersionData, isLoading: isLoadingPlan } = useQuery(
    trpc.planVersions.getById.queryOptions(
      { id: planVersionId, projectSlug: projectSlug ?? "" },
      { enabled: !!planVersionId && !!projectSlug }
    )
  )

  const features = planVersionData?.planVersion?.planFeatures || []
  const meteredFeatures = features.filter((f) => f.featureType === "usage")

  // Auto-select first metered feature
  if (!selectedFeature && meteredFeatures.length > 0) {
    setSelectedFeature(meteredFeatures[0]?.feature?.slug ?? "")
  }

  const curlCommand = `curl -X POST ${API_DOMAIN}v1/customer/reportUsage \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customerId": "${customerId}",
    "featureSlug": "${selectedFeature}",
    "usage": ${usageAmount},
    "idempotenceKey": "${crypto.randomUUID()}"
  }'`

  const handleCopy = async () => {
    await navigator.clipboard.writeText(curlCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success("Copied to clipboard")
  }

  const handleReportUsage = async () => {
    if (!selectedFeature) {
      toast.error("Please select a feature")
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch(`${API_DOMAIN}v1/customer/reportUsage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customerId,
          featureSlug: selectedFeature,
          usage: Number(usageAmount),
          idempotenceKey: crypto.randomUUID(),
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || "Failed to report usage")
      }

      toast.success("Usage reported successfully!")
      next()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    } finally {
      setIsLoading(false)
    }
  }

  if (isLoadingPlan) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (meteredFeatures.length === 0) {
    return (
      <div className={cn("flex max-w-lg flex-col gap-6", className)}>
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-10 items-center justify-center rounded-md bg-yellow-100">
            <Activity className="size-6 text-yellow-600" />
          </div>
          <h1 className="font-bold text-2xl">No Metered Features</h1>
          <p className="text-center text-muted-foreground text-sm">
            The plan you created doesn't have any metered features, so you can't report usage. You
            can proceed to the next step.
          </p>
          <Button onClick={() => next()} className="mt-4">
            Continue
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex max-w-lg flex-col gap-6", className)}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
            <Activity className="size-6 text-primary" />
          </div>
          <h1 className="animate-content font-bold text-2xl delay-0!">Report Usage</h1>
          <div className="animate-content text-center text-muted-foreground text-sm delay-0!">
            Simulate usage for your customer to test metered billing.
          </div>
        </div>

        <div className="animate-content delay-200!">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="ui">Quick Report</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
            </TabsList>

            <TabsContent value="ui" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Report Usage</CardTitle>
                  <CardDescription>
                    Send usage events for your customer's subscription.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="feature">Feature</Label>
                    <Select value={selectedFeature} onValueChange={setSelectedFeature}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a feature" />
                      </SelectTrigger>
                      <SelectContent>
                        {meteredFeatures.map((pf) => (
                          <SelectItem key={pf.id} value={pf.feature?.slug || ""}>
                            {pf.feature?.title} ({pf.feature?.slug})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="usage">Amount</Label>
                    <Input
                      id="usage"
                      type="number"
                      value={usageAmount}
                      onChange={(e) => setUsageAmount(e.target.value)}
                    />
                  </div>
                  <Button className="w-full" onClick={handleReportUsage} disabled={isLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Reporting...
                      </>
                    ) : (
                      "Report Usage"
                    )}
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="curl" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>API Request</CardTitle>
                  <CardDescription>Run this command to report usage via API.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative rounded-md bg-slate-950 p-4 font-mono text-slate-50 text-xs">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all">
                      {curlCommand}
                    </pre>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute top-2 right-2 h-8 w-8 text-slate-400 hover:text-slate-50"
                      onClick={handleCopy}
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <p className="text-muted-foreground text-xs">
                      Use the Quick Report tab to proceed with the onboarding flow.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
