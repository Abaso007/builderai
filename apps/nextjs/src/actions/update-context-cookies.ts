"use server"

import { COOKIES_APP } from "@unprice/config"
import { cookies } from "next/headers"

/**
 * Update the context cookies for the current workspace and project
 * httpOnly cookies cannot be modified by js-cookie
 * so we need to update them via server action
 * @param workspaceSlug - The slug of the workspace to update
 * @param projectSlug - The slug of the project to update
 * @returns void
 */
export async function updateContextCookies(
  workspaceSlug: string | null,
  projectSlug: string | null
) {
  const cookieStore = cookies()

  const cookieOptions = {
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  }

  cookieStore.set(COOKIES_APP.WORKSPACE, workspaceSlug ?? "", cookieOptions)
  cookieStore.set(COOKIES_APP.PROJECT, projectSlug ?? "", cookieOptions)
}
