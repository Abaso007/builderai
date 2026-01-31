"use client"

import { Button } from "@unprice/ui/button"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { BlocksIcon, CommandIcon, SquareUserIcon } from "lucide-react"
import { SuperLink } from "~/components/super-link"

export function FinalStep({ className }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex flex-col items-center gap-2 text-center">
        <Typography variant="h1" className="animate-title">
          You're good to go
        </Typography>
        <Typography
          variant="p"
          affects="muted"
          className="mb-8 w-[640px] max-w-[90vw] animate-title delay-[0.3s]!"
        >
          Go ahead and explore the app. When you're ready, create your first issue by pressing{" "}
          <kbd className="inline-block min-w-[20px] rounded-[3px] border border-input p-[3px] text-center font-medium text-[11px]">
            C
          </kbd>
          .
        </Typography>

        <div className="flex w-[900px] max-w-[90vw] animate-title items-stretch justify-stretch rounded-lg border border-input bg-accent/20 text-left delay-[0.4s]! max-sm:flex-col">
          <div className="grid border-input border-r p-10 sm:w-1/3">
            <SquareUserIcon className="mb-2 size-6" />
            <span className="font-semibold text-md">Tell your team</span>
            <div>
              <span className="text-muted-foreground text-sm">
                Make sure to invite your team members.
              </span>
            </div>
          </div>

          <div className="grid border-input border-r p-10 sm:w-1/3">
            <BlocksIcon className="mb-2 size-6" />
            <span className="font-semibold text-md">Integrate GitHub & Slack</span>
            <div>
              <span className="text-muted-foreground text-sm">
                Link your pull requests and create issues from Slack.
              </span>
            </div>
          </div>

          <div className="grid p-10 sm:w-1/3">
            <CommandIcon className="mb-2 size-6" />
            <span className="font-semibold text-md">Keyboard shortcuts</span>
            <div>
              <span className="text-muted-foreground text-sm">
                Learn the keyboard command by pressing{" "}
                <kbd className="inline-block min-w-[20px] rounded-[3px] border border-input p-[3px] text-center font-medium text-[11px]">
                  ?
                </kbd>
                .
              </span>
            </div>
          </div>
        </div>

        <SuperLink
          href="https://unprice.dev"
          target="_blank"
          rel="noreferrer"
          className="animate-title delay-[0.5s]!"
        >
          <Button className="mt-12 h-12 w-[336px]">Finish Unprice Onboarding</Button>
        </SuperLink>
      </div>
    </div>
  )
}
