import { Logo as LogoIcon } from "@unprice/ui/icons"
import { cn } from "@unprice/ui/utils"
import { siteConfig } from "~/constants/layout"
import { SuperLink } from "../super-link"

export function Logo({ className = "" }) {
  return (
    <SuperLink href="/" className="flex items-center justify-start space-x-2 text-primary-text">
      <LogoIcon className={cn("size-6", className)} />
      <span
        className={cn("inline-flex whitespace-nowrap font-bold text-2xl tracking-tight", className)}
      >
        {siteConfig.name}
      </span>
    </SuperLink>
  )
}
