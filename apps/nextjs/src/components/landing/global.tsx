"use client"
import type { FunctionComponent } from "react"
import { Globe } from "./globe"

export const Global: FunctionComponent = () => {
  const features = [
    {
      name: "Global low latency",
      description: "Tier caching for low-latency global access.",
    },
    {
      name: "Subscription billing",
      description: "Subscription machines for global billing, no matter where you are.",
    },
    {
      name: "Analytics",
      description: "Powered by ClickHouse, the fastest analytics database.",
    },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-16">
      <section
        aria-labelledby="global-database-title"
        className="relative mx-auto flex w-full flex-col items-center justify-center overflow-hidden rounded-3xl pt-16 sm:pt-20 md:pt-24"
      >
        <div className="z-30 inline-block rounded-lg border border-primary-border bg-primary-bg px-3 py-1.5 font-semibold text-primary-text uppercase leading-4 tracking-tight sm:text-sm">
          <span>Made for the cloud</span>
        </div>
        <h2
          id="global-database-title"
          className="z-30 mt-6 inline-block px-4 text-center font-bold text-4xl text-background-textContrast tracking-tighter sm:text-5xl md:text-8xl"
        >
          Works <br /> anywhere
        </h2>
        <Globe className="-translate-x-1/2 absolute top-[120px] left-1/2 z-10 aspect-square w-[90vw] max-w-[400px] sm:top-[180px] sm:w-full sm:max-w-[600px] md:top-[220px] md:max-w-[800px] lg:max-w-[900px]" />
        <div className="-mt-24 sm:-mt-28 md:-mt-32 lg:-mt-36 z-20 h-[28rem] w-full overflow-hidden sm:h-[32rem] md:h-[36rem]">
          <div className="absolute bottom-0 h-3/5 w-full bg-gradient-to-b from-transparent via-background-base to-background-base" />
          <div className="absolute inset-x-6 bottom-12 m-auto max-w-4xl md:top-2/3">
            <div className="grid grid-cols-1 gap-x-10 gap-y-6 rounded-lg border border-white/[3%] bg-white/[1%] px-6 py-6 shadow-xl backdrop-blur md:grid-cols-3 md:p-8">
              {features.map((item) => (
                <div key={item.name} className="flex flex-col gap-2">
                  <h3 className="whitespace-nowrap bg-gradient-to-b from-background-textContrast to-background-textContrast bg-clip-text font-semibold text-lg text-transparent md:text-xl">
                    {item.name}
                  </h3>
                  <p className="text-background-textContrast/40 text-sm leading-6">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
