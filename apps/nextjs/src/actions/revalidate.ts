"use server"

import { revalidatePath, revalidateTag } from "next/cache"

export async function revalidateAppPath(path: string, type: "layout" | "page") {
  revalidatePath(path, type)
}

export async function revalidatePageDomain(domain: string) {
  revalidateTag(`${domain}:page-data`)
  // Also revalidate the page path to clear Next.js route cache
  revalidatePath(`/sites/${domain}`, "page")
}
