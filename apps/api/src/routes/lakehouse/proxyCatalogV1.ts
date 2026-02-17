import { verifyTicket } from "~/auth/ticket"
import { UnpriceApiError } from "~/errors"
import type { App } from "~/hono/app"

const CLOUDFLARE_CATALOG_BASE = "https://catalog.cloudflarestorage.com"
let cachedCatalogConfig: { body: string; updatedAt: number } | null = null

export const registerProxyCatalogV1 = (app: App) => {
  app.all("/v1/lakehouse/catalog/proxy/*", async (c) => {
    const requestUrl = new URL(c.req.url)
    const proxyPrefix = "/v1/lakehouse/catalog/proxy"
    const rawSuffix = requestUrl.pathname.startsWith(proxyPrefix)
      ? requestUrl.pathname.slice(proxyPrefix.length)
      : requestUrl.pathname
    const suffixParts = rawSuffix.split("/").filter(Boolean)

    let suffixPath = rawSuffix
    let tokenFromPath: string | undefined
    let accountIdFromPath: string | undefined
    let bucketNameFromPath: string | undefined

    const looksLikeJwt = (value: string) => value.split(".").length === 3

    if (suffixParts.length > 0 && looksLikeJwt(suffixParts[0] ?? "")) {
      tokenFromPath = suffixParts[0]
      const remaining = suffixParts.slice(1).join("/")
      suffixPath = remaining ? `/${remaining}` : ""
    } else if (suffixParts.length >= 2) {
      accountIdFromPath = suffixParts[0]
      bucketNameFromPath = suffixParts[1]
      const remaining = suffixParts.slice(2).join("/")
      suffixPath = remaining ? `/${remaining}` : ""
    }

    const method = c.req.method.toUpperCase()
    const isConfigRequest = suffixPath.startsWith("/v1/config")

    if (method !== "OPTIONS") {
      const token =
        tokenFromPath ??
        requestUrl.searchParams.get("ticket") ??
        c.req.header("authorization")?.replace("Bearer ", "")

      if (!token) {
        throw new UnpriceApiError({
          code: "UNAUTHORIZED",
          message: "Missing ticket",
        })
      }

      const payload = await verifyTicket({ token, secret: c.env.AUTH_SECRET })

      if (accountIdFromPath && payload.accountId !== accountIdFromPath) {
        throw new UnpriceApiError({
          code: "FORBIDDEN",
          message: "Ticket does not match account",
        })
      }
      if (bucketNameFromPath && payload.bucket !== bucketNameFromPath) {
        throw new UnpriceApiError({
          code: "FORBIDDEN",
          message: "Ticket does not match bucket",
        })
      }

      accountIdFromPath = payload.accountId
      bucketNameFromPath = payload.bucket
    }

    const resolvedAccountId = accountIdFromPath ?? c.env.CLOUDFLARE_ACCOUNT_ID
    const resolvedBucketName = bucketNameFromPath ?? c.env.LAKEHOUSE_BUCKET_NAME
    const apiToken = c.env.LAKEHOUSE_STREAM_AUTH_TOKEN

    const upstreamUrl = new URL(
      `${CLOUDFLARE_CATALOG_BASE}/${resolvedAccountId}/${resolvedBucketName}${suffixPath}`
    )
    upstreamUrl.search = requestUrl.search
    upstreamUrl.searchParams.delete("ticket")

    const headers = new Headers()
    headers.set("Authorization", `Bearer ${apiToken}`)
    const contentType = c.req.header("content-type")
    if (contentType) headers.set("content-type", contentType)

    const upstreamMethod = method === "HEAD" && isConfigRequest ? "GET" : method
    const body =
      upstreamMethod === "GET" || upstreamMethod === "HEAD" ? undefined : await c.req.arrayBuffer()

    const buildCorsHeaders = () => {
      const headers = new Headers()
      headers.set("access-control-allow-origin", "*")
      headers.set(
        "access-control-expose-headers",
        "x-lakehouse-upstream-status,x-lakehouse-upstream-method,x-lakehouse-proxy-cache"
      )
      return headers
    }

    if (method === "OPTIONS") {
      const responseHeaders = buildCorsHeaders()
      const requestedHeaders = c.req.header("access-control-request-headers")
      responseHeaders.set("access-control-allow-methods", "GET,HEAD,POST,PUT,DELETE,OPTIONS")
      responseHeaders.set(
        "access-control-allow-headers",
        requestedHeaders ?? "content-type,range,authorization"
      )
      responseHeaders.set("access-control-max-age", "600")
      return new Response(null, {
        status: 204,
        headers: responseHeaders,
      })
    }

    if (isConfigRequest && method === "HEAD") {
      const responseHeaders = new Headers()
      responseHeaders.set("content-type", "application/json")
      responseHeaders.set("x-lakehouse-proxy-cache", cachedCatalogConfig ? "hit" : "forced")
      const corsHeaders = buildCorsHeaders()
      corsHeaders.forEach((value, key) => responseHeaders.set(key, value))
      return new Response(null, {
        status: 200,
        headers: responseHeaders,
      })
    }

    if (isConfigRequest && method === "HEAD" && cachedCatalogConfig) {
      const responseHeaders = new Headers()
      responseHeaders.set("content-type", "application/json")
      responseHeaders.set("x-lakehouse-proxy-cache", "hit")
      return new Response(null, {
        status: 200,
        headers: responseHeaders,
      })
    }

    const res = await fetch(upstreamUrl.toString(), {
      method: upstreamMethod,
      headers,
      body,
    })

    const contentTypeHeader = res.headers.get("content-type") ?? ""
    const isJsonResponse = contentTypeHeader.includes("application/json")

    const responseHeaders = new Headers()
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return
      responseHeaders.set(key, value)
    })

    responseHeaders.set("x-lakehouse-upstream-status", String(res.status))
    responseHeaders.set("x-lakehouse-upstream-method", upstreamMethod)
    const corsHeaders = buildCorsHeaders()
    corsHeaders.forEach((value, key) => responseHeaders.set(key, value))

    if (!res.ok) {
      if (isConfigRequest && cachedCatalogConfig) {
        responseHeaders.set("content-type", "application/json")
        responseHeaders.set("x-lakehouse-proxy-cache", "stale")
        responseHeaders.delete("content-length")
        return new Response(cachedCatalogConfig.body, {
          status: 200,
          headers: responseHeaders,
        })
      }
      const bodyText = await res.text()
      console.warn("[lakehouse][catalog-proxy] upstream error", {
        status: res.status,
        body: bodyText.slice(0, 1000),
      })
      responseHeaders.set("content-type", "text/plain")
      responseHeaders.delete("content-length")
      return new Response(bodyText, {
        status: res.status,
        headers: responseHeaders,
      })
    }

    if (method === "HEAD" && isConfigRequest) {
      return new Response(null, {
        status: res.status,
        headers: responseHeaders,
      })
    }

    if (res.ok && isConfigRequest && isJsonResponse) {
      try {
        const json = await res.json()
        if (json && typeof json === "object") {
          const maybeDefaults = (json as Record<string, unknown>).defaults
          if (maybeDefaults && typeof maybeDefaults === "object") {
            ;(maybeDefaults as Record<string, unknown>).authorization_type = "none"
          }
        }
        responseHeaders.set("content-type", "application/json")
        responseHeaders.delete("content-length")
        const bodyText = JSON.stringify(json)
        cachedCatalogConfig = { body: bodyText, updatedAt: Date.now() }
        return new Response(bodyText, {
          status: res.status,
          headers: responseHeaders,
        })
      } catch {
        // Fall through to proxy original response if JSON parsing fails.
      }
    }

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    })
  })
}
