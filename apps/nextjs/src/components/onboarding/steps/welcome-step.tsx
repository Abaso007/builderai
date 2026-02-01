import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import Balancer from "react-wrap-balancer"

export function WelcomeStep({ className }: React.ComponentProps<"div">) {
  const { next } = useOnboarding()
  return (
    <div className={cn("flex w-full flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <Typography variant="h1" className="animate-content">
          <Balancer>Welcome to Unprice</Balancer>
        </Typography>
        <Typography variant="p" affects="removePaddingMargin" className="animate-content">
          Manage, iterate, and find the best price for your product.
        </Typography>

        <Button className="mt-8 animate-button" onClick={() => next()}>
          Start pricing
        </Button>
      </div>
    </div>
  )
}
