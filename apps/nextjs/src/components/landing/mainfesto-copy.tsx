"use client"

import { motion, useInView } from "framer-motion"
import { useRef } from "react"

export default function MainfestoCopy() {
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
        Static Pricing is a Choice to Leak Revenue
      </motion.h2>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Most SaaS companies leave 30-50% of their revenue on the table because they treat pricing as
        a static configuration rather than a dynamic product surface.
        <br />
        <br />
        <b>The Static Trap:</b> Your "Pro" plan has been $49/mo for two years. Your product is 10x
        better, but your price hasn't moved. Testing a new tier requires a six-week engineering
        sprint, involving database migrations and billing integration updates. So you wait. And you
        lose revenue daily.
        <br />
        <br />
        <b>The PriceOps Way:</b>
        <br />
        <br />
        Pricing becomes as agile as your codebase. When you ship value, you should be able to
        capture it instantly—without blocking engineering resources.
        <br />
        <br />
        The market demands this shift. Users refuse to pay for unused "seats"; they pay for{" "}
        <b>value.</b>
        <br />
        <br />
        Why do users churn? Often, it’s a misalignment between price and perceived value. In a
        static system, you guess. In an adaptive system, pricing aligns with usage and value
        delivery.
        <br />
        <br />
        Companies using hybrid models see <b>21% higher growth rates</b>.
        <br />
        <br />
        Price is the reflection of your innovation. If your product evolves daily but your pricing
        is frozen, you are carrying a hidden engineering tax.
        <br />
        <br />
        Stop the leak.
      </motion.div>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        Recognize the signs of static pricing debt:
        <br />
        <br />
        <ul className="list-disc pl-10">
          <li>Uncertainty about willingness to pay due to lack of experimentation.</li>
          <li>Inability to adapt pricing without engineering intervention.</li>
          <li>Treating pricing as a backend config, not a strategic lever.</li>
          <li>One-size-fits-all pricing that fails to capture value from different segments.</li>
        </ul>
      </motion.div>
      <motion.div variants={itemVariants} className="mt-6 text-justify text-lg">
        The companies winning today are those who treat pricing as a product, not as a Secondary
        Artifact.
        <br />
        <br />
        Are you ready to join them?
      </motion.div>
    </motion.section>
  )
}
