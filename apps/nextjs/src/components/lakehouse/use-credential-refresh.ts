import { useEffect } from "react"
import { CREDENTIAL_REFRESH_BUFFER } from "./lakehouse-constants"
import { computeExpirationMs } from "./lakehouse-utils"

interface Credentials {
  expiration?: unknown
  ttlSeconds?: unknown
}

export function useCredentialRefresh(
  credentials: Credentials | null | undefined,
  onRefetch: () => void
) {
  useEffect(() => {
    if (!credentials) return

    const expirationMs = computeExpirationMs(credentials.expiration, credentials.ttlSeconds)
    if (!expirationMs) return

    const delayMs = expirationMs - Date.now() - CREDENTIAL_REFRESH_BUFFER
    if (delayMs <= 0) return

    const id = window.setTimeout(() => void onRefetch(), delayMs)
    return () => window.clearTimeout(id)
  }, [credentials, onRefetch])
}
