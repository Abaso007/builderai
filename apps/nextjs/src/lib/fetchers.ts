"use server"

import { unstable_cache } from "next/cache"
import { db } from "./db"

async function fetchPageData(domain: string) {
  const page = await db.query.pages.findFirst({
    where: (page, { eq, or }) => or(eq(page.customDomain, domain), eq(page.subdomain, domain)),
    with: {
      project: true,
    },
  })

  if (!page?.id) return null

  return page
}

export async function getPageData(domain: string, skipCache = false) {
  if (skipCache) {
    // Skip cache and fetch directly from DB (useful for preview mode)
    return fetchPageData(domain)
  }

  const getCachedPage = unstable_cache(async () => fetchPageData(domain), [domain], {
    tags: [`${domain}:page-data`],
  })

  return getCachedPage()
}
