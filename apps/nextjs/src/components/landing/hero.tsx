"use client"

import { APP_DOMAIN } from "@unprice/config"
import { Button, buttonVariants } from "@unprice/ui/button"
import { ChevronRight, GitHub } from "@unprice/ui/icons"
import { motion } from "framer-motion"
import { useTheme } from "next-themes"
import Link from "next/link"
import Balancer from "react-wrap-balancer"
import { useMounted } from "~/hooks/use-mounted"
import { WordRotate } from "./text-effects"

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

export default function Hero() {
  const { theme } = useTheme()
  const isMounted = useMounted()

  return (
    <motion.section
      aria-labelledby="hero-title"
      className="flex min-h-screen flex-col items-center justify-center text-center sm:mt-20"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.h1
        id="hero-title"
        className="inline-block bg-clip-text p-2 font-bold text-4xl text-background-textContrast tracking-tighter sm:text-6xl md:text-7xl"
        variants={itemVariants}
      >
        <Balancer>
          Your product is smart,
          <br /> but your pricing is{" "}
          {isMounted && (
            <WordRotate
              className="italic"
              words={["hardcoded", "brittle", "static", "manual"]}
              shadowColor={theme === "dark" ? "white" : "black"}
            />
          )}
        </Balancer>
      </motion.h1>
      <motion.p
        className="mt-6 max-w-2xl px-4 text-background-text text-lg md:px-0"
        variants={itemVariants}
      >
        <br />
        <br />
        <b>The PriceOps Infrastructure for SaaS.</b> You can finally release the engineering backlog
        from the weight of legacy billing. As you discover the freedom of PriceOps, you’ll realize
        that your pricing is no longer a constraint — it’s an evolution.
        <br />
        <br />
        Ship usage-based, tiered, or hybrid models with a single integration, and watch the friction
        dissolve. No more "billing JIRAs."
        <br />
        <br />
        <span className="text-sm italic opacity-70">
          P.S. We aren't a Stripe wrapper—we're the architecture that makes every provider optional.
        </span>
      </motion.p>
      <motion.div
        className="my-14 flex w-full flex-col justify-center gap-3 px-3 align-middle sm:flex-row"
        variants={itemVariants}
      >
        <Link href={`${APP_DOMAIN}`} className={buttonVariants({ variant: "primary" })}>
          Start pricing
          <ChevronRight className="ml-1 h-4 w-4" />
        </Link>
        <Button asChild variant="link">
          <Link
            href="https://github.com/jhonsfran1165/unprice"
            className="text-background-textContrast"
            target="_blank"
          >
            <span className="mr-1 flex size-6 items-center justify-center rounded-full transition-all">
              <GitHub aria-hidden="true" className="size-5 shrink-0 text-background-textContrast" />
            </span>
            <span>Star on GitHub</span>
          </Link>
        </Button>
      </motion.div>
    </motion.section>
  )
}
