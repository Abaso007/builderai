import { AppWindow, Globe, Link, Settings } from "lucide-react"
import type { DashboardRoute, Shortcut } from "~/types"

export const WORKSPACE_NAV: DashboardRoute[] = [
  {
    icon: AppWindow,
    name: "Projects",
    href: "/",
  },
  {
    icon: Globe,
    name: "Domains",
    href: "/domains",
    featureSlug: "domains",
  },
  {
    icon: Settings,
    name: "Settings",
    href: "/settings",
    disabled: false,
    sidebar: [
      {
        name: "Members",
        href: "/settings/members",
        featureSlug: "access-pro",
      },
      {
        name: "Billing & Usage",
        href: "/settings/billing",
      },
    ],
  },
]

export const WORKSPACE_SHORTCUTS: Shortcut[] = [
  {
    name: "Add member",
    href: "settings/members",
    icon: Link,
    featureSlug: "access-pro",
  },
  {
    name: "Workspace usage",
    href: "settings/billing",
    icon: Link,
  },
  {
    name: "Add domain",
    href: "domains",
    icon: Link,
    featureSlug: "domains",
  },
]
