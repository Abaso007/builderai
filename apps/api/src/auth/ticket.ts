import { UnpriceApiError } from "~/errors"

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()
const TICKET_ISSUER = "unprice-api"
const TICKET_AUDIENCE = "lakehouse-catalog-proxy"
const REALTIME_TICKET_AUDIENCE = "usagelimit-realtime-proxy"
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

export type RealtimeTicketPayload = {
  iss: typeof TICKET_ISSUER
  aud: typeof REALTIME_TICKET_AUDIENCE
  sub: string
  userId: string
  projectId: string
  customerId: string
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

type CreateRealtimeTicketParams = {
  secret: string
  userId: string
  projectId: string
  customerId: string
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

const unauthorized = (message = "Unauthorized"): never => {
  throw new UnpriceApiError({ code: "UNAUTHORIZED", message })
}

const signPayload = async <TPayload>(params: {
  secret: string
  payload: TPayload
}): Promise<string> => {
  const payloadBytes = TEXT_ENCODER.encode(JSON.stringify(params.payload))

  const key = await importSecret(params.secret)
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes)
  const encodedPayload = toHex(payloadBytes)
  const encodedSignature = toHex(new Uint8Array(signature))

  return `${TICKET_VERSION}.${encodedPayload}.${encodedSignature}`
}

const parseTicketParts = (token: string): { encodedPayload: string; encodedSignature: string } => {
  if (!token) {
    unauthorized("Missing ticket")
  }

  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION) {
    unauthorized("Invalid ticket")
  }

  const encodedPayload = parts[1]
  const encodedSignature = parts[2]
  if (!encodedPayload || !encodedSignature) {
    unauthorized("Invalid ticket")
  }

  return { encodedPayload: encodedPayload!, encodedSignature: encodedSignature! }
}

const decodeTicket = async (params: {
  secret: string
  token: string
}): Promise<Uint8Array> => {
  const { encodedPayload, encodedSignature } = parseTicketParts(params.token)

  const parseHexParts = (): { payloadBytes: Uint8Array; signatureBytes: Uint8Array } => {
    try {
      return {
        payloadBytes: fromHex(encodedPayload),
        signatureBytes: fromHex(encodedSignature),
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

  return payloadBytes
}

const parsePayload = <TPayload>(payloadBytes: Uint8Array): TPayload => {
  try {
    return JSON.parse(TEXT_DECODER.decode(payloadBytes)) as TPayload
  } catch {
    unauthorized("Invalid ticket")
  }
  throw new Error("unreachable")
}

const assertCommonClaims = (payload: { exp: number; iat: number }) => {
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    unauthorized("Ticket expired")
  }

  if (typeof payload.iat !== "number" || payload.iat > now) {
    unauthorized("Invalid ticket")
  }
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

  return signPayload({
    secret: params.secret,
    payload,
  })
}

export async function createRealtimeTicket(params: CreateRealtimeTicketParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: RealtimeTicketPayload = {
    iss: TICKET_ISSUER,
    aud: REALTIME_TICKET_AUDIENCE,
    sub: params.userId,
    userId: params.userId,
    projectId: params.projectId,
    customerId: params.customerId,
    iat: now,
    exp: now + Math.max(1, Math.floor(params.expiresInSeconds)),
  }

  return signPayload({
    secret: params.secret,
    payload,
  })
}

export async function verifyTicket(params: {
  secret: string
  token: string
}): Promise<TicketPayload> {
  const payloadBytes = await decodeTicket(params)
  const payload = parsePayload<TicketPayload>(payloadBytes)

  if (payload.iss !== TICKET_ISSUER || payload.aud !== TICKET_AUDIENCE) {
    unauthorized("Invalid ticket")
  }

  assertCommonClaims(payload)

  if (!payload.projectId || !payload.accountId || !payload.bucket) {
    unauthorized("Invalid ticket")
  }

  return payload
}

export async function verifyRealtimeTicket(params: {
  secret: string
  token: string
}): Promise<RealtimeTicketPayload> {
  const payloadBytes = await decodeTicket(params)
  const payload = parsePayload<RealtimeTicketPayload>(payloadBytes)

  if (payload.iss !== TICKET_ISSUER || payload.aud !== REALTIME_TICKET_AUDIENCE) {
    unauthorized("Invalid ticket")
  }

  assertCommonClaims(payload)

  if (!payload.userId || !payload.projectId || !payload.customerId) {
    unauthorized("Invalid ticket")
  }

  return payload
}
