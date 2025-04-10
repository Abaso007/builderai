import { Link } from "next-view-transitions"

import { Logo } from "@unprice/ui/icons"

import { Fragment } from "react"
import Footer from "~/components/layout/footer"
import { siteConfig } from "~/constants/layout"

export default function AuthLayout(props: { children: React.ReactNode }) {
  return (
    <Fragment>
      <div className="relative grid min-h-screen grid-cols-1 overflow-hidden md:grid-cols-3 lg:grid-cols-2">
        <div className="relative">
          <div
            className="absolute inset-0 bg-cover"
            style={{
              backgroundImage:
                "url(https://images.unsplash.com/photo-1590069261209-f8e9b8642343?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1376&q=80)",
            }}
          />

          <div className="absolute inset-0 bg-gradient-to-t from-background to-background/60 md:to-background/40" />
          <Link
            href="/"
            className="absolute top-8 left-8 z-20 flex items-center font-bold text-lg tracking-tight"
          >
            <Logo className="mr-2 h-6 w-6" />
            <span>{siteConfig.name}</span>
          </Link>
        </div>

        <div className="-translate-y-1/2 container absolute top-1/2 col-span-1 flex items-center md:static md:top-0 md:col-span-2 md:flex md:translate-y-0 lg:col-span-1">
          {props.children}
        </div>
      </div>
      <Footer className="border-none" />
    </Fragment>
  )
}
