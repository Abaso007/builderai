import dynamic from "next/dynamic"

import { Button } from "@builderai/ui/button"
import { Skeleton } from "@builderai/ui/skeleton"

import { Logo } from "~/components/layout/logo"
import { MainNav } from "~/components/layout/main-nav"

const ThemeToggle = dynamic(() => import("~/components/layout/theme-toggle"), {
  ssr: false,
  loading: () => (
    <Button variant="ghost" size="sm" className="button-ghost">
      <Skeleton className="h-5 w-5 rounded-full" />
    </Button>
  ),
})

export default function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="bg-background-base top-0 mx-auto w-full border-b px-3 shadow-sm">
      <div className="flex h-14 items-center space-x-2 sm:justify-between sm:space-x-0">
        <div className="flex items-center justify-start">
          <Logo />
          {children && <span className="text-muted-foreground ml-6 mr-4 text-lg font-bold">/</span>}

          {children}
        </div>
        <div className="flex flex-1 items-center justify-end space-x-4 px-4">
          <MainNav />
        </div>
        <ThemeToggle />
      </div>
    </header>
  )
}
