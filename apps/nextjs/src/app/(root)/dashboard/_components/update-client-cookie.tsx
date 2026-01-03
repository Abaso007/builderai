"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef } from "react"
import { updateContextCookies } from "~/actions/update-context-cookies"

/**
 * Update the client cookie on focus tab event
 * for project and workspace
 * normally used in the layout component for client side api calls
 * for server side api calls or rsc, the middleware will handle the cookie update
 */
export function UpdateClientCookie({
  projectSlug,
  workspaceSlug,
}: { projectSlug: string | null; workspaceSlug: string | null }) {
  const queryClient = useQueryClient()
  const firstRender = useRef(true)
  const updateInProgress = useRef(false)
  const throttleTimeout = useRef<NodeJS.Timeout | null>(null)

  const invalidateQueriesProject = useCallback(() => {
    // skip the first render
    if (firstRender.current) {
      firstRender.current = false
      return
    }

    // invalidate queries when project changes
    queryClient.invalidateQueries({
      predicate: (query) => {
        const queryKey0 = query.queryKey[0] as string[]

        // the same user doesn't need to invalidate the workspaces query
        if (queryKey0.includes("workspaces") || queryKey0.includes("domains")) return false

        return true
      },
    })
  }, [queryClient])

  const onFocus = useCallback(async () => {
    // We cannot check if slugs changed because another tab might have changed the cookies.
    // We must always update the cookies to ensure they match the current tab's context.

    // Prevent concurrent requests
    if (updateInProgress.current) {
      return
    }

    // Throttle: prevent rapid-fire requests (max once per 200ms)
    if (throttleTimeout.current) {
      return
    }

    throttleTimeout.current = setTimeout(() => {
      throttleTimeout.current = null
    }, 200)

    updateInProgress.current = true

    try {
      // Update cookies via Server Action because they are httpOnly and cannot be modified by js-cookie
      await updateContextCookies(workspaceSlug, projectSlug)

      // Forcefully invalidate queries to ensure we fetch with the new cookie
      queryClient.invalidateQueries({
        predicate: (query) => {
          const queryKey0 = query.queryKey[0] as string[]

          if (queryKey0.includes("workspaces") || queryKey0.includes("domains")) return false

          return true
        },
      })
    } finally {
      updateInProgress.current = false
    }
  }, [workspaceSlug, projectSlug, queryClient])

  useEffect(() => {
    // We don't need to set cookies on mount because middleware handles it
    invalidateQueriesProject()

    // Use visibilitychange only (more reliable for tab switching, and avoids duplicate events)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onFocus()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      if (throttleTimeout.current) {
        clearTimeout(throttleTimeout.current)
      }
    }
  }, [projectSlug, workspaceSlug, onFocus, invalidateQueriesProject])

  return null
}
