import { getSession } from "@unprice/auth/server-rsc"
import { APP_DOMAIN } from "@unprice/config"
import { Alert, AlertDescription, AlertTitle } from "@unprice/ui/alert"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@unprice/ui/card"
import { Typography } from "@unprice/ui/typography"
import { differenceInCalendarDays } from "date-fns"
import { AlertCircle } from "lucide-react"
import { Fragment } from "react"
import { PaymentMethodForm } from "~/components/forms/payment-method-form"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { formatDate } from "~/lib/dates"
import { unprice } from "#utils/unprice"
import { BillingCard } from "./_components/billing"

export default async function BillingPage({ params }: { params: { workspaceSlug: string } }) {
  const { workspaceSlug } = params
  const session = await getSession()
  const atw = session?.user.workspaces.find((w) => w.slug === workspaceSlug)
  const isMainWorkspace = atw?.isMain
  const customerId = atw?.unPriceCustomerId ?? ""

  if (isMainWorkspace) {
    return (
      <DashboardShell
        header={
          <HeaderTab
            title="Billing Settings"
            description="Manage your payments for this workspace."
          />
        }
      >
        <Alert variant="info">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Main Workspace</AlertTitle>
          <AlertDescription>
            This is the main workspace, there is no need to manage payments or subscriptions for
            this workspace.
          </AlertDescription>
        </Alert>
      </DashboardShell>
    )
  }
  return (
    <DashboardShell
      header={
        <HeaderTab
          title="Billing Settings"
          description="Manage your payments for this workspace."
        />
      }
    >
      <Fragment>
        <SubscriptionCard customerId={customerId} />
        <PaymentMethodCard workspaceSlug={workspaceSlug} customerId={customerId} />
        <UsageCard customerId={customerId} />
      </Fragment>
    </DashboardShell>
  )
}

async function PaymentMethodCard({
  workspaceSlug,
  customerId,
}: {
  workspaceSlug: string
  customerId: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Default Payment Method</CardTitle>
      </CardHeader>
      <CardContent>
        <PaymentMethodForm
          customerId={customerId}
          successUrl={`${APP_DOMAIN}${workspaceSlug}/settings/billing`}
          cancelUrl={`${APP_DOMAIN}${workspaceSlug}/settings/billing`}
          readonly={true}
        />
      </CardContent>
    </Card>
  )
}

async function SubscriptionCard({
  customerId,
}: {
  customerId: string
}) {
  // TODO: customer can only have one subscription for now
  const { result: subscription, error: subscriptionError } =
    await unprice.customers.getSubscription(customerId)

  if (subscriptionError) {
    return (
      <Alert variant="info">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error fetching subscription</AlertTitle>
        <AlertDescription>{subscriptionError.message}</AlertDescription>
      </Alert>
    )
  }

  const activePhase = subscription.activePhase

  if (!activePhase) {
    return (
      <Alert variant="info">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>No active phase</AlertTitle>
      </Alert>
    )
  }

  const { planSlug } = subscription
  const currentTrialDays = activePhase.trialEndsAt
    ? differenceInCalendarDays(activePhase.trialEndsAt, Date.now())
    : 0

  /**
   * if the customer is in trial days, we need to show the trial days left and when the trial ends
   * if the customer is not in trial days and the plan is not auto renewing, we need to show the next billing date and when the subscription ends
   * if the plan is auto renewing, we need to show the next billing date
   */

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription Info</CardTitle>
      </CardHeader>
      <CardContent>
        {subscription ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-md">
                {currentTrialDays > 0 ? "Trial" : "Subscription"} Plan:{" "}
                <span className="inline-flex items-center gap-1">
                  <span className="font-bold">{planSlug}</span>
                </span>
              </div>

              {/* <div className="flex items-center gap-2">
                <SubscriptionChangePlanDialog
                  defaultValues={{
                    id: subscription.result.id,
                    planVersionId: "",
                    config: [],
                    whenToChange: "end_of_cycle",
                    currentCycleEndAt: subscription.result.currentCycleEndAt,
                    timezone: subscription.result.timezone,
                    projectId: subscription.result.projectId,
                    currentPlanVersionId: activePhase.result.planVersion.id,
                  }}
                >
                  <Button size="sm">Change Plan</Button>
                </SubscriptionChangePlanDialog>
              </div> */}
            </div>
            <div className="gap-2 rounded-lg bg-background-bg p-4">
              <Typography variant="h6">Current Billing Cycle</Typography>
              <Typography variant="p">
                {formatDate(subscription.currentCycleStartAt, subscription.timezone, "MMM d, yyyy")}{" "}
                - {formatDate(subscription.currentCycleEndAt, subscription.timezone, "MMM d, yyyy")}
              </Typography>
              <div className="flex flex-col py-4">
                <Typography variant="p" affects="removePaddingMargin">
                  <span className="font-bold">
                    Your subscription {activePhase.startAt > Date.now() ? "will start" : "started"}{" "}
                    at:
                  </span>{" "}
                  {formatDate(activePhase.startAt, subscription.timezone, "MMM d, yyyy")}
                </Typography>
                <Typography variant="p" affects="removePaddingMargin">
                  <span className="font-bold">Next billing date:</span>{" "}
                  {formatDate(subscription.invoiceAt, subscription.timezone, "MMM d, yyyy")}
                </Typography>
              </div>
            </div>
            {currentTrialDays > 0 && activePhase.trialEndsAt && (
              <Alert>
                <AlertTitle>Trial Period</AlertTitle>
                <AlertDescription>
                  {activePhase.trialDays} days trial ends on{" "}
                  {formatDate(activePhase.trialEndsAt, subscription.timezone, "MMM d, yyyy")}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className="py-8 text-center">
            <p className="font-semibold text-gray-700 text-xl">
              You are not subscribed to any plan.
            </p>
            <p className="mt-2 text-gray-500">Choose a plan to get started with our services.</p>
          </div>
        )}
      </CardContent>
      <CardFooter />
    </Card>
  )
}

async function UsageCard({ customerId }: { customerId: string }) {
  const { error, result } = await unprice.customers.getUsage(customerId)

  if (error) {
    return (
      <Alert variant="info">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error fetching data</AlertTitle>
        <AlertDescription>{error?.message}</AlertDescription>
      </Alert>
    )
  }

  if (!result)
    return (
      <Alert variant="info">
        <AlertTitle>No Usage Data</AlertTitle>
        <AlertDescription>You don't have any usage data for this subscription.</AlertDescription>
      </Alert>
    )

  return <BillingCard usage={result} />
}
