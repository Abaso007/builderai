import { useOnboarding } from "@onboardjs/react"
import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import UnpriceLogo from "@unprice/ui/unprice"
import { cn } from "@unprice/ui/utils"
import { useTheme } from "next-themes"
import Balancer from "react-wrap-balancer"

export function WelcomeStep({ className }: React.ComponentProps<"div">) {
  const { next } = useOnboarding()
  const { theme } = useTheme()
  return (
    <div className={cn("flex w-full flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        {/* biome-ignore lint/a11y/useValidAnchor: <explanation> */}
        <a href="#" className="flex flex-col items-center gap-2 font-medium">
          <div className="relative flex size-32 items-center justify-center rounded-md">
            <UnpriceLogo
              className="z-10 animate-logo"
              theme={theme as "dark" | "light"}
              variant="full"
              size="lg"
            />
          </div>
          <span className="sr-only">Unprice</span>
        </a>
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
