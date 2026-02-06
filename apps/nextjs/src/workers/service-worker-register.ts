/**
 * Register the Lakehouse service worker for caching /api/lakehouse/file responses
 */
export async function lakehouseRegisterSW(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    console.warn("Lakehouse Service Workers not supported")
    return
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    })

    console.info("Lakehouse Service Worker registered:", registration.scope)

    // Handle updates
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing
      if (newWorker) {
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            console.info("New Lakehouse Service Worker available")
          }
        })
      }
    })
  } catch (error) {
    console.error("Lakehouse Service Worker registration failed:", error)
  }
}

/**
 * Unregister the Lakehouse service worker (for debugging)
 */
export async function lakehouseUnregisterSW(): Promise<void> {
  if (!("serviceWorker" in navigator)) return

  const registrations = await navigator.serviceWorker.getRegistrations()
  for (const registration of registrations) {
    await registration.unregister()
  }
  console.info("Lakehouse Service Workers unregistered")
}
