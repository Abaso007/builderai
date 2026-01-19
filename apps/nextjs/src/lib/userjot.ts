import { createHmac } from "node:crypto"
import { env } from "~/env"

export function getUserJotToken(userId: string) {
  const secret = env.USERJOT_SECRET

  if (!secret) {
    return undefined
  }

  return createHmac("sha256", secret).update(userId).digest("hex")
}
