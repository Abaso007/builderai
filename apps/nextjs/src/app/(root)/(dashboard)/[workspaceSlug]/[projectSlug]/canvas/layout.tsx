import { DashboardShell } from "~/components/layout2/dashboard-shell"
import { NewCanvaDialog } from "./_components/new-canva"

export default function ProjectSettingsLayout(props: {
  children: React.ReactNode
  params: { workspaceSlug: string; projectSlug: string }
}) {
  return (
    <DashboardShell
      title="Canvas"
      module="project"
      submodule="canvas"
      action={<NewCanvaDialog />}
    >
      {props.children}
    </DashboardShell>
  )
}
