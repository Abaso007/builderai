import type { ReactNode } from "react"
import { Suspense } from "react"
import Link from "next/link"

import { auth } from "@builderai/auth"
import { siteConfig } from "@builderai/config"
import { buttonVariants } from "@builderai/ui/button"
import * as Icons from "@builderai/ui/icons"

import Footer from "~/components/footer"
import MaxWidthWrapper from "~/components/max-width-wrapper"
import { MobileDropdown } from "~/components/mobile-nav"
import { MainNav } from "../(dashboard)/_components/main-nav"

export default function MarketingLayout(props: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <nav className="z-50 flex h-16 items-center border-b bg-background">
        <MaxWidthWrapper className="flex max-w-screen-2xl">
          <div className="mr-8 hidden items-center md:flex">
            <Icons.Logo className="mr-2 h-6 w-6" />
            <span className="text-lg font-bold tracking-tight">
              {siteConfig.name}
            </span>
          </div>
          <MobileDropdown />
          <MainNav />
          <div className="ml-auto flex items-center space-x-4">
            <Suspense>
              <DashboardLink />
            </Suspense>
          </div>
        </MaxWidthWrapper>
      </nav>

      <main className="flex-1">{props.children}</main>
      <Footer />
    </div>
  )
}

function DashboardLink() {
  const { orgSlug, sessionClaims } = auth()
  const workspaceSlug = orgSlug ? orgSlug : (sessionClaims?.username as string)

  if (!workspaceSlug) {
    return (
      <Link
        href={`${process.env.NEXTJS_URL}/signin`}
        className={buttonVariants({ variant: "outline" })}
      >
        Sign In
        <Icons.ChevronRight className="ml-1 h-4 w-4" />
      </Link>
    )
  }

  return (
    <Link
      href={`${process.env.NEXTJS_URL}/${workspaceSlug}`}
      className={buttonVariants({ variant: "outline" })}
    >
      Dashboard
      <Icons.ChevronRight className="ml-1 h-4 w-4" />
    </Link>
  )
}
