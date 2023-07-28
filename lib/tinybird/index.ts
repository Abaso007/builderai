import { NextRequest, userAgent } from "next/server"

import { LOCALHOST_GEO_DATA } from "@/lib/constants"
import { publishPageView } from "@/lib/tinybird/publish"
import { capitalize, getDomainWithoutWWW, nanoid } from "@/lib/utils"

/**
 * Recording clicks with geo, ua, referer and timestamp data
 * If key is not specified, record click as the root click ("_root", e.g. dub.sh, vercel.fyi)
 **/
export async function recordPageView({
  domain,
  req,
  key,
}: {
  domain?: string
  req: NextRequest
  key?: string
}) {
  const geo = process.env.VERCEL === "1" ? req.geo : LOCALHOST_GEO_DATA
  const ua = userAgent(req)
  const referer = req.headers.get("referer")
  const pageViewId = nanoid()

  const pageViewObject = {
    id: pageViewId,
    time: new Date(Date.now()).toISOString(),
    domain,
    key: key || "_root",
    country: geo?.country || "Unknown",
    city: geo?.city || "Unknown",
    region: geo?.region || "Unknown",
    latitude: geo?.latitude || "Unknown",
    longitude: geo?.longitude || "Unknown",
    ua: ua.ua || "Unknown",
    browser: ua.browser.name || "Unknown",
    browser_version: ua.browser.version || "Unknown",
    engine: ua.engine.name || "Unknown",
    engine_version: ua.engine.version || "Unknown",
    os: ua.os.name || "Unknown",
    os_version: ua.os.version || "Unknown",
    device: ua.device.type ? capitalize(ua.device.type) : "Desktop",
    device_vendor: ua.device.vendor || "Unknown",
    device_model: ua.device.model || "Unknown",
    cpu_architecture: ua.cpu?.architecture || "Unknown",
    bot: ua.isBot,
    referer: referer ? getDomainWithoutWWW(referer) : "(direct)",
    referer_url: referer || "(direct)",
  }

  return await publishPageView(pageViewObject)
}
