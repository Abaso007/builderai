"use client"

import { motion } from "framer-motion"
import Balancer from "react-wrap-balancer"
import { UnpriceManifesto } from "./unprice-manifesto"

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
      type: "spring",
      stiffness: 100,
      damping: 20,
    },
  },
}

export default function HeroManifest() {
  return (
    <div>
      <motion.section
        aria-labelledby="hero-title"
        className="mt-32 flex flex-col items-center justify-center text-center sm:mt-40"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.h1
          id="hero-title"
          className="inline-block p-2 font-bold text-2xl text-background-textContrast tracking-tighter sm:text-6xl md:text-7xl"
          variants={itemVariants}
        >
          <Balancer>PriceOps Infrastructure</Balancer>
        </motion.h1>
        <motion.p
          className="mt-20 max-w-2xl px-4 text-center text-background-text text-lg md:px-0"
          variants={itemVariants}
        >
          SaaS pricing was built for a static era. Hardcoded tiers, manual feature gating, and
          quarterly pricing reviews are relics. You know that world is ending.
          <br />
          <br />
          <span className="font-bold italic">The market has already shifted.</span>
          <br />
          <br />
          Today, users demand personalized value. While your product ships daily, your pricing
          infrastructure often remains frozen. The gap between your innovation and your monetization
          is where revenue is lost.
          <br />
          <br />
          Static pricing isn’t just outdated. It’s technical debt that bleeds value.
          <br />
          <br />
          In a world where AI shifts the horizon overnight, pricing must be an{" "}
          <span className="font-bold italic">adaptive engine</span>, not a static config.
        </motion.p>
      </motion.section>
      <UnpriceManifesto />
    </div>
  )
}
