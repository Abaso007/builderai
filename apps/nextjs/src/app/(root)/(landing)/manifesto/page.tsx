import type { Metadata } from "next"
import dynamic from "next/dynamic"
import HeroManifest from "~/components/landing/hero-manifest"
import { LazyMotionWrapper } from "~/components/landing/lazy-motion-wrapper"

const Belief = dynamic(() => import("~/components/landing/belief"))
const MainfestoCopy = dynamic(() => import("~/components/landing/mainfesto-copy"))
const PillarsPriceOps = dynamic(() => import("~/components/landing/pillarsAMI"))

export const metadata: Metadata = {
  title: "Manifesto",
  description: "Our vision for the future of pricing and revenue infrastructure.",
}

export default function Manifesto() {
  return (
    <LazyMotionWrapper>
      <main className="flex flex-col overflow-hidden pb-28">
        <HeroManifest />

        <div className="mx-auto flex w-full max-w-4xl flex-col overflow-hidden px-3">
          <MainfestoCopy />
          <PillarsPriceOps />
          <Belief />
        </div>
      </main>
    </LazyMotionWrapper>
  )
}
