import { UnpriceApiError } from "~/errors"

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()
const TICKET_ISSUER = "unprice-api"
const TICKET_AUDIENCE = "lakehouse-catalog-proxy"
const TICKET_VERSION = "v1"

export type TicketPayload = {
  iss: typeof TICKET_ISSUER
  aud: typeof TICKET_AUDIENCE
  sub: string
  projectId: string
  accountId: string
  bucket: string
  customerId?: string
  eventDate?: string
  iat: number
  exp: number
}

type CreateTicketParams = {
  secret: string
  projectId: string
  accountId: string
  bucket: string
  customerId?: string
  eventDate?: string
  expiresInSeconds: number
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const fromHex = (input: string): Uint8Array => {
  const normalized = input.trim().toLowerCase()
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex input")
  }
  const bytes = new Uint8Array(normalized.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    const chunk = normalized.slice(i * 2, i * 2 + 2)
    const value = Number.parseInt(chunk, 16)
    if (Number.isNaN(value)) {
      throw new Error("Invalid hex input")
    }
    bytes[i] = value
  }
  return bytes
}

const importSecret = async (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )

const unauthorized = (message = "Unauthorized") => {
  throw new UnpriceApiError({ code: "UNAUTHORIZED", message })
}

export async function createTicket(params: CreateTicketParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: TicketPayload = {
    iss: TICKET_ISSUER,
    aud: TICKET_AUDIENCE,
    sub: params.projectId,
    projectId: params.projectId,
    accountId: params.accountId,
    bucket: params.bucket,
    customerId: params.customerId,
    eventDate: params.eventDate,
    iat: now,
    exp: now + Math.max(1, Math.floor(params.expiresInSeconds)),
  }

  const payloadBytes = TEXT_ENCODER.encode(JSON.stringify(payload))

  const key = await importSecret(params.secret)
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes)
  const encodedPayload = toHex(payloadBytes)
  const encodedSignature = toHex(new Uint8Array(signature))

  return `${TICKET_VERSION}.${encodedPayload}.${encodedSignature}`
}

export async function verifyTicket(params: {
  secret: string
  token: string
}): Promise<TicketPayload> {
  if (!params.token) {
    unauthorized("Missing ticket")
  }

  const parts = params.token.split(".")
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION) {
    unauthorized("Invalid ticket")
  }

  const encodedPayload = parts[1]
  const encodedSignature = parts[2]
  if (typeof encodedPayload !== "string" || typeof encodedSignature !== "string") {
    unauthorized("Invalid ticket")
  }
  const encPayload = encodedPayload as string
  const encSig = encodedSignature as string

  const parseHexParts = (): { payloadBytes: Uint8Array; signatureBytes: Uint8Array } => {
    try {
      return {
        payloadBytes: fromHex(encPayload),
        signatureBytes: fromHex(encSig),
      }
    } catch {
      unauthorized("Invalid ticket")
    }
    throw new Error("unreachable")
  }
  const { payloadBytes, signatureBytes } = parseHexParts()

  const key = await importSecret(params.secret)
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as BufferSource,
    payloadBytes as BufferSource
  )
  if (!verified) unauthorized("Invalid ticket")

  const parsePayload = (): TicketPayload => {
    try {
      return JSON.parse(TEXT_DECODER.decode(payloadBytes)) as TicketPayload
    } catch {
      unauthorized("Invalid ticket")
    }
    throw new Error("unreachable")
  }
  const payload = parsePayload()

  if (payload.iss !== TICKET_ISSUER || payload.aud !== TICKET_AUDIENCE) {
    unauthorized("Invalid ticket")
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    unauthorized("Ticket expired")
  }

  if (!payload.projectId || !payload.accountId || !payload.bucket) {
    unauthorized("Invalid ticket")
  }

  return payload
}
