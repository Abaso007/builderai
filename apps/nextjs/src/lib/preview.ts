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

function fromHex(hex: string) {
  if (hex.length % 2 !== 0) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "===".slice((normalized.length + 3) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
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
    const decoded = new TextDecoder().decode(fromBase64Url(token))
    const [id, expires, signature] = decoded.split(":")
    if (!id || !expires || !signature) return false
    if (id !== pageId) return false
    if (Number(expires) < Date.now()) return false

    const payload = `${id}:${expires}`
    const key = await getHmacKey(env.ENCRYPTION_KEY)
    const signatureBuffer = fromHex(signature)
    if (!signatureBuffer) return false

    return await crypto.subtle.verify("HMAC", key, signatureBuffer, encoder.encode(payload))
  } catch {
    return false
  }
}
