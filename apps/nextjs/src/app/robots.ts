import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/pricing", "/manifesto"],
        disallow: ["/dashboard/", "/api/", "/auth/"],
      },
    ],
    sitemap: "https://unprice.dev/sitemap.xml",
  }
}
