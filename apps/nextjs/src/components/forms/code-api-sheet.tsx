"use client"

import { useState } from "react"

import { DOCS_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@unprice/ui/sheet"
import { Code } from "lucide-react"
import Link from "next/link"
import { SDKDemo, type method } from "../landing/sdk-examples"

export function CodeApiSheet({
  children,
  defaultMethod,
}: {
  children?: React.ReactNode
  defaultMethod?: method
}) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open)
      }}
    >
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent className="hide-scrollbar flex max-h-screen w-full flex-col justify-start overflow-y-auto overflow-x-hidden lg:w-[800px]">
        <SheetHeader>
          <SheetTitle className="text-2xl">Code API</SheetTitle>
          <SheetDescription>Use the code API to get the price of a product</SheetDescription>
        </SheetHeader>
        <SDKDemo className="mt-2 bg-background-base" defaultMethod={defaultMethod} />
        <SheetFooter className="mt-6">
          <Link href={`${DOCS_DOMAIN}/api-reference`} target="_blank">
            <Button variant="outline">
              <Code className="mr-2 h-4 w-4" />
              See API reference
            </Button>
          </Link>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
