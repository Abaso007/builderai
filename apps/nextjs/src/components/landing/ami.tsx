"use client"
import { BASE_URL } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { motion, useInView } from "framer-motion"
import Link from "next/link"
import { useRef } from "react"

export default function PriceOpsSection() {
  const sectionRef = useRef(null)
  const isInView = useInView(sectionRef, { once: true, margin: "-100px" })

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.2,
        delayChildren: 0.3,
      },
    },
  }

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.5,
        ease: "easeOut",
      },
    },
  }

  return (
    <motion.section
      ref={sectionRef}
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={containerVariants}
      aria-labelledby="code-example-title"
      className="mx-auto w-full max-w-4xl px-4 py-10"
    >
      <motion.h2
        variants={itemVariants}
        id="features-title"
        className="mt-2 inline-block bg-clip-text py-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-6xl"
      >
        PriceOps Infrastructure
      </motion.h2>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        SaaS pricing was built for a static world. You know the friction: hardcoded plans, complex
        feature gating logic, and the "quarterly review" that turns into a sprint-draining
        migration. That era is ending.
        <br />
        <br />
        Today, value is dynamic. As your product ships daily, the gap between your innovation and
        your billing infrastructure widens.
        <br />
        <br />
        We believe pricing is the most underutilized growth lever in SaaS. It's time to stop
        treating revenue as a config file and start treating it as a product surface. Experience the
        control of iterating on pricing without blocking engineering.
        <div className="mt-10 flex justify-end">
          <Link href={`${BASE_URL}/manifesto`}>
            <Button variant="outline">Read the Manifesto</Button>
          </Link>
        </div>
      </motion.div>
    </motion.section>
  )
}
