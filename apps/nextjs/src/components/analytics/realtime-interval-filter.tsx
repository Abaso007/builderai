"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { cn } from "@unprice/ui/utils"
import { Calendar } from "lucide-react"
import { useHotkeys } from "react-hotkeys-hook"
import { useRealtimeIntervalFilter } from "~/hooks/use-filter"
import { realtimeIntervalValues } from "~/lib/searchParams"

const options = [
  { value: String(realtimeIntervalValues[0]), label: "Last 5 minutes", hotkey: "1" },
  { value: String(realtimeIntervalValues[1]), label: "Last 60 minutes", hotkey: "2" },
  { value: String(realtimeIntervalValues[2]), label: "Last 1 day", hotkey: "3" },
  { value: String(realtimeIntervalValues[3]), label: "Last 7 days", hotkey: "4" },
] as const

export function RealtimeIntervalFilter({ className }: { className?: string }) {
  const [windowSeconds, setWindowSeconds] = useRealtimeIntervalFilter()

  const hotkeys = options.map((option) => option.hotkey)
  useHotkeys(hotkeys, (_, handler) => {
    const key = handler.keys?.at(0)
    if (!key) return

    const interval = options.find(
      (option) => option.hotkey.toLocaleUpperCase() === key.toLocaleUpperCase()
    )

    if (interval) {
      setWindowSeconds({ realtimeInterval: interval.value })
    }
  })

  return (
    <Select
      value={String(windowSeconds)}
      onValueChange={(value) => {
        setWindowSeconds({ realtimeInterval: value })
      }}
    >
      <SelectTrigger className={cn("w-60 items-start [&_[data-description]]:hidden", className)}>
        <div className="flex items-center gap-2 font-medium text-xs">
          <Calendar className="size-4" />
          <SelectValue placeholder="Select time window" />
        </div>
      </SelectTrigger>
      <SelectContent className="w-60">
        {options.map((option) => {
          return (
            <SelectItem
              value={option.value}
              key={option.value}
              className="font-medium text-xs"
              shortcut={option.hotkey}
              description={`Look back at the ${option.label.toLowerCase()}`}
            >
              {option.label}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
