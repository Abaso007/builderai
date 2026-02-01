"use client"

import { useState } from "react"

import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@unprice/ui/sheet"

import { useActiveFeature, usePlanVersionFeatureOpen } from "~/hooks/use-features"
import { FeatureConfig } from "./feature-config"

export function PlanVersionFeatureSheet({
  children,
  planFeatureVersion,
}: {
  label?: string
  children?: React.ReactNode
  planFeatureVersion?: PlanVersionFeatureDragDrop
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [_, setPlanVersionFeatureOpen] = usePlanVersionFeatureOpen()
  const [__, setActiveFeature] = useActiveFeature()

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (open && planFeatureVersion) {
          setActiveFeature(planFeatureVersion)
        }
        setIsOpen(open)
        setPlanVersionFeatureOpen(open)
      }}
    >
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent className="flex max-h-screen w-full flex-col justify-between overflow-y-scroll md:w-1/2 lg:w-[600px]">
        <SheetHeader>
          <SheetTitle className="text-2xl">Plan version feature form</SheetTitle>
          <SheetDescription>Configure the feature for the plan version</SheetDescription>
        </SheetHeader>

        <FeatureConfig
          setDialogOpen={(open) => {
            setIsOpen(open)
            setPlanVersionFeatureOpen(open)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
