"use client"
import { APP_DOMAIN } from "@unprice/config"
import { buttonVariants } from "@unprice/ui/button"
import { m, useInView } from "framer-motion"
import { ChevronRight } from "lucide-react"
import Link from "next/link"
import { useRef } from "react"

export default function Belief() {
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
      aria-labelledby="vision-title"
      className="mx-auto mt-40 px-4"
    >
      <m.h2
        variants={itemVariants}
        id="features-title"
        className="inline-block py-2 font-bold text-4xl text-background-textContrast tracking-tighter md:text-5xl"
      >
        Our Belief
      </m.h2>
      <m.div variants={itemVariants} className="mt-6 space-y-4">
        <p className="text-justify text-lg leading-8">
          We believe SaaS founders and AI builders deserve full control over the value they create.
          <br />
          <br />
          Static plans, vendor lock-in, and engineering bottlenecks are relics of a previous era.
          PriceOps is your strategic advantage. Transparency is your security.
          <br />
          <br />
          We’re not here to tweak pricing around the edges.
          <br />
          We’re here to architect the entire monetization stack from the ground up.
          <br />
          <br />
          You don’t need permission to innovate.
          <br />
          You don’t need to guess your tiers.
          <br />
          You don’t need to wait for a deployment to change a price.
          <br />
          <br />
          Some companies discover they've been leaving money on the table for years. Others find
          they can test new models in days instead of quarters. What would change if pricing moved
          as fast as your product?
          <br />
          <br />
          Experience PriceOps — built on your terms, with fully transparent code and at any scale.
          <br />
          <br />
          <span className="font-bold italic">
            Pricing is the most neglected growth lever in SaaS. We're here to change that.
          </span>
          <br />
          <br />
          <span className="font-bold italic">Unprice, the PriceOps Infrastructure.</span>
        </p>
      </m.div>
      <m.div
        className="mx-auto mt-20 flex w-fit justify-center p-1.5"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.6 }}
      >
        <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
          Start pricing
          <ChevronRight className="ml-1 h-4 w-4" />
        </Link>
      </m.div>
    </m.section>
  )
}
