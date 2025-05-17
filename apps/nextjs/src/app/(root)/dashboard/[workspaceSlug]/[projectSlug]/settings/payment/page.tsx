import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { api } from "~/trpc/server"
import { StripePaymentConfigForm } from "./_components/stripe-payment-config-form"

export default async function ProjectPaymentSettingsPage() {
  const provider = await api.paymentProvider.getConfig({
    paymentProvider: "stripe",
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-row items-center justify-between">
          <div className="flex flex-col space-y-1.5">
            <CardTitle>Stripe configuration</CardTitle>
            <CardDescription>
              Configure the API key for connection to your stripe account
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <StripePaymentConfigForm
          provider={provider.paymentProviderConfig}
          paymentProvider="stripe"
        />
      </CardContent>
    </Card>
  )
}
