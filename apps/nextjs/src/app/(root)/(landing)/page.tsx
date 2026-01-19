import PriceOpsSection from "~/components/landing/ami"
import CodeExample from "~/components/landing/code-example"
import Cta from "~/components/landing/cta"
import { Features } from "~/components/landing/features"
import { FeaturesApp } from "~/components/landing/features-app"
import { Global } from "~/components/landing/global"
import Hero from "~/components/landing/hero"
import LogoCloud from "~/components/landing/logo-cloud"
import { PricingHero } from "~/components/landing/pricing-hero"

export default function Home() {
  return (
    <main className="flex flex-col overflow-hidden pb-28">
      <Hero />{" "}
      <PricingHero
        headline="Click to bill. Experience the precision."
        description="Notice how 1,000,000 events transform into one perfect invoice. Experience the clarity of the metering engine below."
        docsLinkText="Read the Docs"
      />
      <PriceOpsSection />
      <Features />
      <CodeExample />
      {/* <Testimonials /> */}
      <FeaturesApp />
      <Global />
      <LogoCloud />
      <Cta />
    </main>
  )
}
