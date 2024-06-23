import { Button } from "@builderai/ui/button"
import { Card, CardContent, CardHeader } from "@builderai/ui/card"
import { Skeleton } from "@builderai/ui/skeleton"
import { Plus } from "lucide-react"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { DomainDialog } from "./_components/domain-dialog"

export const runtime = "edge"

export default function DomainPageLoading() {
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Domains"
          description="Domains for this workspace"
          action={
            <DomainDialog>
              <Button>
                <Plus className="size-4 mr-2" />
                Create Domain
              </Button>
            </DomainDialog>
          }
        />
      }
    >
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex flex-row items-center">
              <Skeleton className="h-6 w-[150px]" />

              <Skeleton className="ml-2 h-6 w-6" />

              <Skeleton className="ml-2 w-[200px] rounded-md" />
            </div>

            <div className="flex flex-row items-center justify-between space-x-2">
              <Skeleton className="h-6 w-[50px]" />

              <Skeleton className="h-6 w-[50px]" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="bg-background-bg p-4" />
        </CardContent>
      </Card>
    </DashboardShell>
  )
}
