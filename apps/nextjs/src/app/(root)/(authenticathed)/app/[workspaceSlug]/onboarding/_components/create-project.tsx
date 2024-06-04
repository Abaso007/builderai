"use client"

import { LazyMotion, domAnimation, m } from "framer-motion"
import dynamic from "next/dynamic"
import { useParams, useRouter } from "next/navigation"
import { Balancer } from "react-wrap-balancer"

const CreateProjectForm = dynamic(() => import("../../_components/create-project-form"), {
  ssr: false,
})

export default function CreateProject() {
  const router = useRouter()
  const workspaceSlug = useParams().workspaceSlug as string

  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className="my-auto flex h-full w-full flex-col items-center justify-center"
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.3, type: "spring" }}
      >
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
          className="bg-background/60 flex flex-col rounded-xl p-8"
        >
          <m.h1
            className="mb-4 text-2xl font-bold transition-colors sm:text-3xl"
            variants={{
              hidden: { opacity: 0, x: 250 },
              show: {
                opacity: 1,
                x: 0,
                transition: { duration: 0.4, type: "spring" },
              },
            }}
          >
            <Balancer>{`Let's start off by creating your first project`}</Balancer>
          </m.h1>
          <m.div
            variants={{
              hidden: { opacity: 0, x: 100 },
              show: {
                opacity: 1,
                x: 0,
                transition: { duration: 0.4, type: "spring" },
              },
            }}
          >
            <CreateProjectForm
              workspaceSlug={workspaceSlug}
              onSuccess={({ slug }) => {
                const searchParams = new URLSearchParams(window.location.search)
                searchParams.set("step", "create-api-key")
                searchParams.set("projectSlug", slug)
                router.push(`/${workspaceSlug}/onboarding?${searchParams.toString()}`)
              }}
            />
          </m.div>
        </m.div>
      </m.div>
    </LazyMotion>
  )
}
