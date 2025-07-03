"use client"

import { motion } from "framer-motion"
import { Check, X } from "lucide-react"
import type { PricingPlan } from "./pricing-card"

interface FeatureComparisonProps {
  plans: PricingPlan[]
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
      delayChildren: 0.4,
    },
  },
}

function FeatureCell({
  value,
}: {
  value:
    | {
        value: string | number | boolean
        title: string
        type: "flat" | "usage" | "tier" | "package"
      }
    | undefined
}) {
  if (value === undefined) {
    return <X className="mx-auto h-5 w-5 text-danger" />
  }

  if (value.type === "flat") {
    return value ? (
      <Check className="mx-auto h-5 w-5 text-success" />
    ) : (
      <X className="mx-auto h-5 w-5 text-danger" />
    )
  }
  return <span className="text-sm">{value.value}</span>
}

export function FeatureComparison({ plans }: FeatureComparisonProps) {
  // Extract all unique features from all plans
  const allFeatureNames = new Set<string>()

  plans.forEach((plan) => {
    if (plan.features) {
      plan.detailedFeatures.forEach((feature) => {
        Object.keys(feature).forEach((key) => {
          allFeatureNames.add(key)
        })
      })
    }
  })

  // Convert to sorted array
  const sortedFeatures = Array.from(allFeatureNames).sort()

  // If no detailed features are provided, don't show the comparison
  if (sortedFeatures.length === 0) {
    return null
  }

  // Dynamic grid columns based on number of plans
  const gridColsClass =
    {
      2: "grid-cols-3", // 1 feature + 2 plans
      3: "grid-cols-4", // 1 feature + 3 plans
      4: "grid-cols-5", // 1 feature + 4 plans
      5: "grid-cols-6", // 1 feature + 5 plans
    }[plans.length] || "grid-cols-5"

  return (
    <motion.div
      className="mx-auto w-full max-w-6xl py-10"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <h2 className="mb-8 text-center font-bold text-3xl">Compare all features</h2>

      <div className="overflow-hidden rounded-lg border bg-card backdrop-blur-sm">
        {/* Header */}
        <div className={`grid ${gridColsClass} gap-4 border-b bg-muted/50 p-6`}>
          <div className="font-medium">Features</div>
          {plans.map((plan) => (
            <div key={plan.name} className="text-center">
              <div className="font-medium">{plan.name}</div>
              <div className="text-muted-foreground text-sm">
                {plan.isEnterprisePlan
                  ? "Custom pricing"
                  : `${plan.currency}${plan.flatPrice}/${plan.billingPeriod}`}
              </div>
            </div>
          ))}
        </div>

        {/* Features */}
        <div className="p-6">
          <div className="space-y-4">
            {sortedFeatures.map((featureName) => (
              <div key={featureName} className={`grid ${gridColsClass} gap-4 py-2`}>
                <div className="flex items-center gap-2">
                  <span>{featureName}</span>
                </div>
                {plans.map((plan) => {
                  const value = plan.detailedFeatures.find((feature) => feature[featureName])?.[
                    featureName
                  ]

                  return (
                    <div key={plan.name} className="flex items-center justify-center">
                      <FeatureCell value={value} />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
