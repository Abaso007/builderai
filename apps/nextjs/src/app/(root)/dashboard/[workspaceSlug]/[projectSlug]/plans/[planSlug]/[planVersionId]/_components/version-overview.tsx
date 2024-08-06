import { Pencil } from "lucide-react"

import type { RouterOutputs } from "@unprice/api"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardFooter } from "@unprice/ui/card"
import { Separator } from "@unprice/ui/separator"
import { cn } from "@unprice/ui/utils"

import { Typography } from "@unprice/ui/typography"
import { CopyButton } from "~/components/copy-button"
import { PlanVersionDialog } from "../../_components/plan-version-dialog"
import { BannerInactiveVersion, BannerPublishedVersion } from "./banner"

export default function VersionOverview({
  planVersion,
}: {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card className="border-none bg-background-base shadow-none">
        <div className="flex flex-col">
          <div className="flex h-[70px] shrink-0 items-center justify-between space-x-1 px-0 py-2">
            <div className="flex items-center space-x-2">
              <Typography variant="h3" className="truncate">
                {planVersion.plan.slug}
              </Typography>

              <div
                className={cn("inline-flex items-center font-semibold text-xs", {
                  "text-success": planVersion.status === "published",
                  "text-info": planVersion.status !== "published",
                })}
              >
                <span
                  className={cn("flex h-2 w-2 rounded-full", {
                    "bg-success-solid": planVersion.status === "published",
                    "bg-info": planVersion.status !== "published",
                  })}
                />
                <span className="ml-1">{planVersion.status}</span>
              </div>
            </div>
            <PlanVersionDialog defaultValues={planVersion}>
              <Button size="sm" variant="default">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </PlanVersionDialog>
          </div>
        </div>
        <Separator />
        <CardContent className="px-0 py-4 text-sm">
          <div className="grid gap-3">
            <div className="font-semibold">Basic Information</div>

            <Typography variant="p" affects="removePaddingMargin">
              {planVersion.description}
            </Typography>

            <dl className="grid gap-3">
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">Title</dt>
                <dd>{planVersion.title}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">Version</dt>
                <dd>v{planVersion.version}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">Currency</dt>
                <dd>{planVersion.currency}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">Type</dt>
                <dd>{planVersion.planType}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">Billing Period</dt>
                <dd>{planVersion.billingPeriod}</dd>
              </div>
            </dl>
          </div>
          <Separator className="my-4" />
          <div className="grid gap-3">
            <div className="font-semibold">Billing Information</div>
            <dl className="grid gap-3">
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">Provider</dt>
                <dd>{planVersion.paymentProvider}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">Grace period</dt>
                <dd>{planVersion.gracePeriod}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1 text-muted-foreground">start Cycle</dt>
                <dd>{planVersion.startCycle}</dd>
              </div>
            </dl>
          </div>
        </CardContent>
        <CardFooter className="flex flex-row items-center border-t px-0 py-4">
          <div className="flex items-center text-muted-foreground text-xs">
            <Typography variant="p" affects="small" className="mr-2">
              {planVersion.id}
            </Typography>
            <CopyButton value={planVersion.id} className="size-4" />
          </div>
        </CardFooter>
      </Card>
      {!planVersion.active && <BannerInactiveVersion />}
      {planVersion.status === "published" && <BannerPublishedVersion />}
    </div>
  )
}
