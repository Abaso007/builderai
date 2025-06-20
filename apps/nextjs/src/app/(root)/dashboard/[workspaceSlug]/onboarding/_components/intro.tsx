"use client"

import { LazyMotion, domAnimation, m } from "framer-motion"
import { useParams, useRouter } from "next/navigation"
import { Balancer } from "react-wrap-balancer"

import { Button } from "@unprice/ui/button"

import { useDebounce } from "~/hooks/use-debounce"

export default function Intro() {
  const router = useRouter()
  const workspaceSlug = useParams().workspaceSlug as string

  const showText = useDebounce(true, 800)

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className="flex h-full w-full flex-col items-center justify-center"
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.3, type: "spring" }}
      >
        {showText && (
          <m.div
            variants={{
              show: {
                transition: {
                  staggerChildren: 0.2,
                },
              },
            }}
            initial="hidden"
            animate="show"
            className="mx-5 flex flex-col items-center space-y-6 text-center sm:mx-auto"
          >
            <m.h1
              className="font-bold text-4xl transition-colors sm:text-5xl"
              variants={{
                hidden: { opacity: 0, y: 50 },
                show: {
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.4, type: "spring" },
                },
              }}
            >
              <Balancer>Welcome to Unprice</Balancer>
            </m.h1>
            <m.p
              className="max-w-md text-muted-foreground transition-colors sm:text-lg"
              variants={{
                hidden: { opacity: 0, y: 50 },
                show: {
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.4, type: "spring" },
                },
              }}
            >
              Manage, iterate, and find the best price for your SaaS.
            </m.p>
            <m.div
              variants={{
                hidden: { opacity: 0, y: 50 },
                show: {
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.4, type: "spring" },
                },
              }}
            >
              <Button
                onClick={() =>
                  router.push(`
                  /${workspaceSlug}/onboarding?step=create-project
                `)
                }
              >
                Create your first project
              </Button>
            </m.div>
          </m.div>
        )}
      </m.div>
    </LazyMotion>
  )
}
