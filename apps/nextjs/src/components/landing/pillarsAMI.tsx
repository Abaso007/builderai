"use client"

import { m, useInView } from "framer-motion"
import { BarChart, Code, DollarSign, TrendingUp } from "lucide-react"
import { useRef } from "react"
import { AnimatedBeamDemo } from "./animated-beam-demo"

const PillarsOfPriceOps = [
  {
    title: "Adaptive Revenue Engine",
    icon: <BarChart className="h-5 w-5" />,
    description:
      "Launch any model—usage-based, seat-based, or hybrid—in real-time. Stop guessing and start iterating.",
    practice: "Pricing is a product surface. Treat it like one.",
  },
  {
    title: "Engineering Independence",
    icon: <TrendingUp className="h-5 w-5" />,
    description:
      "Release the billing burden from your backlog. Run pricing experiments and change plans instantly, allowing developers to focus on core product value.",
    practice: "Pricing logic belongs to business teams. Not backlogs.",
  },
  {
    title: "Vendor Freedom",
    icon: <DollarSign className="h-5 w-5" />,
    description:
      "Realize that vendor lock-in is a choice, not a necessity. Swap providers (Stripe, Paddle) with complete transparency and zero code changes.",
    practice: "Payments are infrastructure, not dependencies.",
  },
  {
    title: "Transparent Standard",
    icon: <Code className="h-5 w-5" />,
    description:
      "Monetization is too critical to be a black box. Build on an open AGPL-core: transparent, auditable, and owned by you.",
    practice: "Your revenue engine should be auditable and programmable.",
  },
]

export default function PillarsPriceOps() {
  const sectionRef = useRef(null)
  const isInView = useInView(sectionRef, { once: true, margin: "-100px" })

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
        delayChildren: 0.1,
      },
    },
  }

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.3,
        ease: "easeOut",
      },
    },
  }

  return (
    <m.section
      ref={sectionRef}
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
      aria-labelledby="benefits-title"
      className="mx-auto mt-28 px-4"
    >
      <m.h2
        variants={itemVariants}
        id="benefits-title"
        className="inline-block py-2 font-bold text-4xl text-background-textContrast tracking-tighter md:text-5xl"
      >
        The Solution: PriceOps
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Unprice is the foundation of a new category: <b>PriceOps Infrastructure</b>. It’s the
        abstraction layer that transforms pricing from a "hardcoded nightmare" into your sharpest
        growth engine.
        <br />
        <br />
        <b>What is PriceOps?</b>
        <br />
        PriceOps is the methodology of treating pricing as a dynamic product feature rather than a
        static configuration. It gives you the power to handle pricing like a billion-dollar SaaS,
        right from day one.
        <br />
        <br />
        <b>Why PriceOps Matters?</b>
        <br />
        <ul className="my-4 list-disc pl-10">
          <li>
            <span className="font-semibold">Zero Engineering Latency:</span> Launch new experiments
            in minutes. If you have an idea for a new plan at 10 AM, it should be live by 10:05 AM.
          </li>
          <li>
            <span className="font-semibold">Hyper-Segmentation:</span> Tailor pricing for different
            segments, regions, or AI usage patterns without breaking your codebase.
          </li>
          <li>
            <span className="font-semibold">Value-Based Capture:</span> Automatically track usage
            and charge for the actual value you deliver, increasing LTV and reducing churn.
          </li>
        </ul>
        <br />
        Stop treating pricing as a Secondary Artifact.
        <br />
        <br />
        <b>The future of SaaS is Adaptive.</b>
      </m.div>

      <m.div variants={itemVariants} className="my-28 flex justify-center">
        <AnimatedBeamDemo />
      </m.div>

      <m.dl
        variants={itemVariants}
        className="mt-8 grid grid-cols-4 gap-x-10 gap-y-8 sm:mt-12 sm:gap-y-10"
      >
        {PillarsOfPriceOps.map((pillar) => (
          <div key={pillar.title} className="col-span-4 sm:col-span-2 lg:col-span-1">
            <dt className="flex items-center gap-2 font-semibold text-primary-text">
              {pillar.icon}
              {pillar.title}
            </dt>
            <dd className="mt-2 leading-7">{pillar.description}</dd>
            <dd className="mt-2 font-semibold text-muted-foreground text-sm italic leading-7">
              &quot;{pillar.practice}&quot;
            </dd>
          </div>
        ))}
      </m.dl>
    </m.section>
  )
}
