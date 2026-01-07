"use client"

import { AnimatePresence } from "framer-motion"
import dynamic from "next/dynamic"
import { useSearchParams } from "next/navigation"
import CreatePaymentConfig from "./create-payment-config"

const Intro = dynamic(() => import("./intro"), {
  ssr: false,
})
const Done = dynamic(() => import("./done"), {
  ssr: false,
})
const CreateProject = dynamic(() => import("./create-project"), {
  ssr: false,
})

// TODO: no need to create api key for now
// const CreateApiKey = dynamic(() => import("./create-api-key"), {
//   ssr: false,
// })

export function Onboarding(props: { workspaceSlug: string }) {
  const search = useSearchParams()
  const step = search.get("step")

  return (
    <div className="mx-auto flex h-[calc(100vh-14rem)] w-full max-w-screen-sm flex-col items-center">
      <AnimatePresence mode="wait">
        {!step && <Intro key="intro" nextStep="create-project" />}
        {step === "create-project" && <CreateProject nextStep="create-payment-config" />}
        {step === "create-payment-config" && <CreatePaymentConfig nextStep="done" />}
        {/* {step === "create-api-key" && <CreateApiKey />} */}
        {step === "done" && <Done workspaceSlug={props.workspaceSlug} />}
      </AnimatePresence>
    </div>
  )
}
