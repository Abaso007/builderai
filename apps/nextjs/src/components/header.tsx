import dynamic from "next/dynamic"

import { Logo } from "~/components/logo"
import { MainNav } from "~/components/main-nav"
import { ProjectSwitcher } from "~/components/project-switcher"
import { Tab } from "~/components/tab"
import { UserNav } from "~/components/user-nav"
import { WorkspaceSwitcher } from "~/components/workspace-switcher"
import { api } from "~/trpc/server"

const TabsNav = dynamic(() => import("~/components/tabs-nav"), {
  ssr: false,
  loading: () => (
    <nav className="flex items-center gap-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Tab.Skeleton key={i} />
      ))}
    </nav>
  ),
})

export default function Header({ showTabs }: { showTabs: boolean }) {
  return (
    <header className="sticky top-0 z-50 mx-auto w-full border-b bg-background-bgSubtle bg-clip-padding px-2 backdrop-blur-xl md:px-10">
      <div className="flex h-16 items-center space-x-2 bg-background-bgSubtle sm:justify-between sm:space-x-0">
        <div className="flex items-center justify-start">
          <Logo />
          <span className="mx-4 text-lg font-bold text-muted-foreground">
            /
          </span>
          <WorkspaceSwitcher />
          <ProjectSwitcher
            projectsPromise={api.project.listByActiveWorkspace.query()}
          />
        </div>
        <div className="flex flex-1 items-center justify-end space-x-4">
          <MainNav />
          <UserNav />
        </div>
      </div>

      {showTabs && <TabsNav />}
    </header>
  )
}
