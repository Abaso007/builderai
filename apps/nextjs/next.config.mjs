import "@builderai/api/env"
import "@builderai/auth/env"
import "@builderai/stripe/env"
import "./src/env.mjs"

// import MillionLint from "@million/lint"
import createMDX from "@next/mdx"

/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  /** Enables hot reloading for local packages without a build step */
  transpilePackages: [
    "@builderai/api",
    "@builderai/db",
    "@builderai/stripe",
    "@builderai/ui",
    "@builderai/auth",
    "@builderai/config",
    "@builderai/tailwind-config",
  ],
  pageExtensions: ["ts", "tsx", "mdx"],
  images: {
    domains: ["images.unsplash.com"],
  },
  // swcMinify: true,
  experimental: {
    ppr: true,
    mdxRs: true,
    optimizePackageImports: ["@builderai/ui", "@builderai/api", "@builderai/auth", "@builderai/db"],
    instrumentationHook: true,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.ignoreWarnings = [{ module: /opentelemetry/ }]
    }
    return config
  },
  /** We already do linting and typechecking as separate tasks in CI */
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
}

const withMDX = createMDX({
  // Add markdown plugins here, as desired
  options: {
    remarkPlugins: [],
    rehypePlugins: [],
  },
})

export default withMDX(nextConfig)

// TODO: try to use million
// export default MillionLint.next({
//   rsc: true,
//   filter: {
//     include: "**.{mtsx,mjsx,tsx,jsx}",
//   },
// })(withMDX()(nextConfig))

// TODO: https://www.flavienbonvin.com/reduce-next-js-bundle/
