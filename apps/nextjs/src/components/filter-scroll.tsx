"use client"

import { ScrollArea } from "@unprice/ui/scroll-area"
import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import { useRef } from "react"
import { useScrollProgress } from "~/hooks/use-scroll-progress"

export const FilterScroll = ({
  children,
  className,
  maxHeight = 200,
}: { children: React.ReactNode; className?: string; maxHeight?: number }) => {
  const scrollAreaRef = useRef(null)

  const { scrollProgress, updateScrollProgress } = useScrollProgress(
    scrollAreaRef,
    "[data-radix-scroll-area-viewport]"
  )

  return (
    <div className="relative" style={{ maxHeight: `${maxHeight}px` }}>
      <ScrollArea
        hideScrollBar={true}
        ref={scrollAreaRef}
        onScrollCapture={updateScrollProgress}
        className={cn(
          "hide-scrollbar",
          // hack for not having to set height on scroll area
          `[&>[data-radix-scroll-area-viewport]]:max-h-[${maxHeight}px]`,
          className
        )}
      >
        {children}
        <motion.div
          className="pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-b from-transparent to-background-bgHover"
          style={{ opacity: 1 - scrollProgress ** 2 }}
          transition={{ duration: 0.2 }}
        />
      </ScrollArea>
    </div>
  )
}
