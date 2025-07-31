import { schemaPageHit, schemaPlanClick } from "@unprice/tinybird"
import { analytics } from "@unprice/tinybird/client"
import { EU_COUNTRY_CODES } from "@unprice/tinybird/utils"
import { geolocation, ipAddress } from "@vercel/functions"
import { type NextRequest, userAgent } from "next/server"
import { z } from "zod"
import { env } from "~/env"
import { capitalize } from "~/lib/capitalize"
import { detectBot, getDomainWithoutWWW } from "~/lib/domains"
import { LOCALHOST_GEO_DATA, LOCALHOST_IP } from "~/lib/localhost"
import { setCorsHeaders } from "../_enableCors"

export const maxDuration = 10
export const runtime = "edge"

/**
 * Post event to Tinybird HFI
 *
 * @param  { string } payload Event object
 * @return { Promise<string> } Tinybird HFI response
 */
const trackPageHit = async (
  req: NextRequest,
  payload: {
    session_id: string
    page_id: string
    plan_ids: string | null
    locale: string
    referrer: string
    pathname: string
    url: string
  }
): Promise<{ successful_rows: number; quarantined_rows: number } | null | string> => {
  try {
    // validate payload
    const parsedPayload = schemaPageHit.safeParse(payload)

    if (!parsedPayload.success) {
      // TODO: send to bug reporting
      console.error(parsedPayload.error)
      return `Invalid payload: ${JSON.stringify(parsedPayload.error)}`
    }

    // get user agent
    const ua = userAgent(req)
    const isBot = detectBot(req)

    // don't track bots
    if (isBot) {
      return "Bot detected"
    }

    const ip = env.VERCEL_ENV === "production" ? ipAddress(req) : LOCALHOST_IP

    // get continent, region & geolocation data
    // interesting, geolocation().region is Vercel's edge region – NOT the actual region
    // so we use the x-vercel-ip-country-region to get the actual region
    const { continent, region } =
      env.VERCEL === "1"
        ? {
            continent: req.headers.get("x-vercel-ip-continent"),
            region: req.headers.get("x-vercel-ip-country-region"),
          }
        : LOCALHOST_GEO_DATA

    const geo = env.VERCEL === "1" ? geolocation(req) : LOCALHOST_GEO_DATA

    const isEuCountry = geo.country && EU_COUNTRY_CODES.includes(geo.country)

    const event = {
      timestamp: new Date(Date.now()).toISOString(),
      session_id: payload.session_id,
      page_id: payload.page_id,
      ip:
        // only record IP if it's a valid IP and not from a EU country
        typeof ip === "string" && ip.trim().length > 0 && !isEuCountry ? ip : "",
      plan_ids: payload.plan_ids?.split(",") || [],
      continent: continent || "",
      country: geo.country || "Unknown",
      region: region || "Unknown",
      city: geo.city || "Unknown",
      latitude: geo.latitude || "Unknown",
      longitude: geo.longitude || "Unknown",
      vercel_region: geo.region || "",
      device: capitalize(ua.device.type) || "Desktop",
      device_vendor: ua.device.vendor || "Unknown",
      device_model: ua.device.model || "Unknown",
      browser: ua.browser.name || "Unknown",
      browser_version: ua.browser.version || "Unknown",
      engine: ua.engine.name || "Unknown",
      engine_version: ua.engine.version || "Unknown",
      os: ua.os.name || "Unknown",
      os_version: ua.os.version || "Unknown",
      cpu_architecture: ua.cpu?.architecture || "Unknown",
      ua: ua.ua || "Unknown",
      bot: ua.isBot,
      referrer: payload.referrer ? getDomainWithoutWWW(payload.referrer) || "(direct)" : "(direct)",
      referrer_url: payload.referrer || "(direct)",
      locale: payload.locale,
      pathname: payload.pathname,
      url: payload.url,
    }

    const response = await analytics.ingestPageEvents(event)
    return response
  } catch (error) {
    // TODO: send to bug reporting
    console.error(error)
    return `Error: ${JSON.stringify(error)}`
  }
}

const bodySchema = z.object({
  action: z.enum(["page_hit", "plan_click"]),
  session_id: z.string(),
  payload: z.string(),
})

// TODO: protect this route with a credentials/rate-limit to prevent abuse
export async function POST(req: NextRequest) {
  // don't track HEAD requests to avoid non-user traffic from inflating click count
  if (req.method === "HEAD") {
    return new Response(JSON.stringify({ error: "Invalid method" }), { status: 400 })
  }

  const body = await req.json()

  const parsedBody = bodySchema.safeParse(body)

  if (!parsedBody.success) {
    return new Response(JSON.stringify({ error: parsedBody.error.message }), { status: 400 })
  }

  const payload = JSON.parse(parsedBody.data.payload)

  switch (parsedBody.data.action) {
    case "page_hit": {
      const result = await trackPageHit(req, {
        session_id: parsedBody.data.session_id,
        ...payload,
      })

      const response = new Response(JSON.stringify(result))
      setCorsHeaders(response)
      return response
    }

    case "plan_click": {
      // validate payload
      const parsedPayload = schemaPlanClick.safeParse(payload)

      if (!parsedPayload.success) {
        return new Response(JSON.stringify({ error: parsedPayload.error.message }), { status: 400 })
      }

      const result = await analytics.ingestEvents({
        action: "plan_click",
        session_id: parsedBody.data.session_id,
        payload: parsedPayload.data,
        version: "1",
        timestamp: new Date(Date.now()).toISOString(),
      })

      const response = new Response(JSON.stringify(result))
      setCorsHeaders(response)
      return response
    }

    default: {
      const response = new Response(JSON.stringify({ error: "Invalid action" }), { status: 400 })
      setCorsHeaders(response)
      return response
    }
  }
}
