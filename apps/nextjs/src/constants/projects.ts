import { Dashboard } from "@unprice/ui/icons"
import { Calculator, Key, Link, Settings, Sticker, Users } from "lucide-react"
import type { DashboardRoute } from "~/types"

export const PROJECT_NAV: DashboardRoute[] = [
  {
    name: "Overview",
    icon: Dashboard,
    href: "/dashboard",
  },
  {
    name: "Revenue Models",
    icon: Calculator,
    href: "/plans",
    disabled: false,
    isNew: true,
    slug: "plans",
  },
  {
    name: "Pages",
    icon: Sticker,
    href: "/pages",
    slug: "pages",
  },
  // {
  //   name: "Events",
  //   icon: BarChartIcon,
  //   href: "/ingestions",
  //   disabled: true,
  //   slug: "ingestions",
  // },
  {
    name: "API Keys",
    href: "/apikeys",
    icon: Key,
    slug: "apikeys",
  },
  {
    name: "Customers",
    href: "/customers",
    icon: Users,
    slug: "customers",
  },
  {
    name: "Settings",
    href: "/settings",
    icon: Settings,
    sidebar: [
      {
        name: "Danger",
        href: "/settings/danger",
      },
      {
        name: "Infrastructure",
        href: "/settings/payment",
      },
    ],
  },
]

export const PROJECT_SHORTCUTS = [
  {
    name: "View Models",
    href: "plans",
    icon: Link,
  },
  {
    name: "Provision Customer",
    href: "customers/subscriptions/new",
    icon: Link,
  },
  {
    name: "All Customers",
    href: "customers",
    icon: Link,
  },
]
