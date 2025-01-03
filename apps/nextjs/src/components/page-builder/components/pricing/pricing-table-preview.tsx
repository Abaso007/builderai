import type { UserComponent } from "@craftjs/core"
import { PricingCard } from "~/components/forms/pricing-card"
import type { PricingComponentProps } from "./types"

export const PricingTablePreview: UserComponent<PricingComponentProps> = (props) => {
  const { plans } = props

  return (
    <div className="flex w-full flex-col items-center justify-center gap-5 md:flex-row md:items-stretch">
      {plans.length > 0 && plans.map((plan) => <PricingCard key={plan.id} planVersion={plan} />)}
    </div>
  )
}
