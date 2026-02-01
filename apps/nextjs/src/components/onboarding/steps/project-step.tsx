import { GalleryVerticalEnd } from "lucide-react"
import { useParams } from "next/navigation"

import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { cn } from "@unprice/ui/utils"
import { updateContextCookies } from "~/actions/update-context-cookies"
import { ProjectForm } from "~/app/(root)/dashboard/[workspaceSlug]/_components/project-form"

export function ProjectStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { updateContext, next, state } = useOnboarding()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()

  return (
    <div className={cn("flex max-w-md flex-col gap-6", className)}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          {/* biome-ignore lint/a11y/useValidAnchor: <explanation> */}
          <a href="#" className="flex flex-col items-center gap-2 font-medium">
            <div className="flex size-8 animate-content items-center justify-center rounded-md delay-0!">
              <GalleryVerticalEnd className="size-6" />
            </div>
          </a>
          <h1 className="animate-content font-bold text-2xl delay-0!">Create a new Project</h1>
          <div className="animate-content text-center text-sm delay-0!">
            Projects are used to group your products and services.
          </div>
        </div>
        <div className="animate-content delay-[0.2s]!">
          <ProjectForm
            defaultValues={
              state?.context.flowData?.project ?? {
                defaultCurrency: "USD",
                timezone: "UTC",
                name: "Acme project",
                url: "https://acme.com",
              }
            }
            onSuccess={async (project) => {
              // Set cookies so the pricing chat API can access the project
              await updateContextCookies(workspaceSlug, project.slug)

              updateContext({
                flowData: {
                  project,
                },
              })
              next()
            }}
          />
        </div>
      </div>
    </div>
  )
}
