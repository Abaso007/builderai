"use client"
import { Progress } from "@unprice/ui/progress"
import { cn } from "@unprice/ui/utils"
import { nFormatter } from "~/lib/nformatter"

export function ProgressBar({
  value,
  max,
  className,
}: {
  value: number
  max: number
  className?: string
}) {
  const progress = (value / max) * 100

  return (
    <div className="flex items-center">
      <Progress value={progress} className={cn("h-2 w-full", className)} max={100} />
      <span className="ml-2 text-content-subtle text-xs">{nFormatter(max)}</span>
    </div>
  )
}