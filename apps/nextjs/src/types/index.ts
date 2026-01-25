import type { LucideIcon } from "lucide-react"

export interface Shortcut {
  name: string
  href: string
  icon: LucideIcon
  featureSlug?: string
}

export interface SidebarRoute {
  name: string
  icon?: LucideIcon
  href: string
  featureSlug?: string
}

export interface DashboardRoute {
  name: string
  featureSlug?: string
  isNew?: boolean
  href: string
  disabled?: boolean
  icon: LucideIcon
  sidebar?: SidebarRoute[]
}

export interface Route {
  title: string
  href: string
  disabled?: boolean
}

export interface SiteConfig {
  name: string
  description: string
  links: {
    twitter: string
    github: string
    dashboard: string
  }
}
