import { env } from "~/env"

const encoder = new TextEncoder()

async function getHmacKey(secret: string) {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}

/**
 * Encodes a preview token using Web Crypto API (Edge-friendly)
 * expires in 10 minutes by default
 */
export async function generatePreviewToken(pageId: string, expiresInMs = 10 * 60 * 1000) {
  const expires = Date.now() + expiresInMs
  const payload = `${pageId}:${expires}`
  const key = await getHmacKey(env.ENCRYPTION_KEY)
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  const signature = Buffer.from(signatureBuffer).toString("hex")
  return Buffer.from(`${payload}:${signature}`).toString("base64url")
}

/**
 * Verifies a preview token using Web Crypto API (Edge-friendly)
 */
export async function verifyPreviewToken(token: string, pageId: string) {
  try {
    const decoded = Buffer.from(token, "base64url").toString()
    const [id, expires, signature] = decoded.split(":")
    if (!id || !expires || !signature) return false
    if (id !== pageId) return false
    if (Number(expires) < Date.now()) return false

    const payload = `${id}:${expires}`
    const key = await getHmacKey(env.ENCRYPTION_KEY)
    const signatureBuffer = new Uint8Array(Buffer.from(signature, "hex"))

    return await crypto.subtle.verify("HMAC", key, signatureBuffer, encoder.encode(payload))
  } catch {
    return false
  }
}
