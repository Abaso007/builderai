import type { ReactNode } from "react"

import { cn } from "@builderai/ui/utils"

export default function MaxWidthWrapper({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("container mx-auto w-full max-w-screen-xl py-4", className)}>{children}</div>
  )
}
