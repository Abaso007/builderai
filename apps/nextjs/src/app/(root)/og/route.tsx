import { ImageResponse } from "@vercel/og"
import { siteConfig } from "~/constants/layout"

export const runtime = "edge"

// Helper function to load a font from Google Fonts
async function loadGoogleFont(font: string, text: string) {
  const url = `https://fonts.googleapis.com/css2?family=${font}&text=${encodeURIComponent(text)}`

  // Use a very old User-Agent to force Google Fonts to return .ttf
  const ua = "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:40.0) Gecko/20100101 Firefox/40.1"

  try {
    const res = await fetch(url, { headers: { "User-Agent": ua } })
    if (!res.ok) return null

    const css = await res.text()
    // Specifically look for .ttf or .otf files to avoid Satori wOF2 errors
    const resource = css.match(/src: url\((.+?\.ttf|.+?\.otf)\)/i)

    // If no .ttf/.otf found, try to find any URL but only if we haven't found a better match
    const fallbackResource = css.match(/src: url\((.+?)\)/)
    const fontUrl = resource?.[1] || fallbackResource?.[1]

    if (fontUrl) {
      const fontRes = await fetch(fontUrl)
      if (fontRes.ok) {
        const buffer = await fontRes.arrayBuffer()
        // Simple check for wOF2 signature (first 4 bytes)
        const signature = new Uint8Array(buffer).slice(0, 4)
        const signatureStr = Array.from(signature)
          .map((b) => String.fromCharCode(b))
          .join("")

        if (signatureStr === "wOF2") {
          console.warn("Google Fonts returned wOF2 even with old UA, skipping...")
          return null
        }

        return buffer
      }
    }
  } catch (e) {
    console.error(`Failed to load font from Google Fonts: ${font}`, e)
  }
  return null
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const title = searchParams.get("title") || siteConfig.name
  const description =
    searchParams.get("description") ||
    "Unprice, PriceOps infrastructure for SaaS. Stop hardcoding your revenue."
  const rawLogoUrl = searchParams.get("logo")

  // Validate logoUrl is HTTPS and optionally from trusted domains
  let logoUrl: string | null = null
  if (rawLogoUrl) {
    try {
      const url = new URL(rawLogoUrl)
      if (url.protocol === "https:") {
        logoUrl = rawLogoUrl
      }
    } catch {
      // Invalid URL, ignore
    }
  }

  // List of reliable font URLs to try in order
  const fontUrls = [
    // 1. Google Fonts (Geist)
    () => loadGoogleFont("Geist", title + description + siteConfig.name),
    // 2. Google Fonts (Inter)
    () => loadGoogleFont("Inter", title + description + siteConfig.name),
    // 3. Vercel's Geist Font (Direct CDN - jsdelivr gh)
    async () => {
      const res = await fetch(
        "https://cdn.jsdelivr.net/gh/vercel/geist-font@1.4.2/packages/next/dist/fonts/geist-sans/Geist-Bold.ttf"
      )
      return res.ok ? res.arrayBuffer() : null
    },
    // 4. Vercel's Geist Font (Direct CDN - jsdelivr npm)
    async () => {
      const res = await fetch(
        "https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/Geist-Bold.otf"
      )
      return res.ok ? res.arrayBuffer() : null
    },
    // 5. RSMS Inter Font (Direct CDN)
    async () => {
      const res = await fetch("https://rsms.me/inter/font-files/Inter-SemiBold.otf")
      return res.ok ? res.arrayBuffer() : null
    },
  ]

  let font: ArrayBuffer | null = null
  for (const getFont of fontUrls) {
    try {
      font = await getFont()
      if (font) break
    } catch (e) {
      console.error("Font loading attempt failed", e)
    }
  }

  if (!font) {
    return new Response(
      "Failed to load fonts for OG image generation. Please check network connectivity.",
      { status: 500 }
    )
  }

  // Simplified Logo for Satori (no filters)
  const SimpleLogo = ({ size = 80, color = "#ffc53d" }: { size?: number; color?: string }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Unprice Logo"
    >
      {/* Left Pillar */}
      <rect x="3" y="4" width="3" height="16" fill={color} />
      {/* Right Pillar */}
      <rect x="18" y="4" width="3" height="16" fill={color} />
      {/* The Foundation (Bottom) */}
      <rect x="3" y="17" width="18" height="3" fill={color} />
    </svg>
  )

  // Default Pluto landing page OG image
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#111110",
        backgroundImage:
          "radial-gradient(circle at 25px 25px, #222221 2%, transparent 0%), radial-gradient(circle at 75px 75px, #222221 2%, transparent 0%)",
        backgroundSize: "100px 100px",
        color: "white",
        fontSize: 100,
        fontWeight: 900,
        fontFamily: "Geist",
      }}
    >
      {/* Header with logo area */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "40px",
          gap: "16px",
        }}
      >
        {logoUrl ? (
          // biome-ignore lint/a11y/useAltText: <explanation>
          <img
            src={logoUrl}
            style={{ width: "80px", height: "80px", borderRadius: "12px", objectFit: "contain" }}
          />
        ) : (
          <SimpleLogo size={80} color="#ffc53d" />
        )}
        <span
          style={{
            fontSize: "72px",
            fontWeight: 600,
            color: "#ffc53d",
            letterSpacing: "-0.03em",
            textTransform:
              title.toLowerCase() === siteConfig.name.toLowerCase() ? "lowercase" : "none",
          }}
        >
          {title}
        </span>
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: "32px",
          color: "#a1a1aa",
          textAlign: "center",
          maxWidth: "800px",
          lineHeight: "1.3",
          marginBottom: "40px",
        }}
      >
        {description}
      </div>

      {/* Feature highlights - only show for Unprice main site */}
      {!logoUrl && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "40px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "#222221",
              padding: "16px 24px",
              borderRadius: "12px",
              border: "1px solid #374151",
            }}
          >
            <span style={{ fontSize: "24px", marginRight: "12px" }}>📊</span>
            <span style={{ fontSize: "20px", color: "#e5e7eb" }}>Track usage</span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "#222221",
              padding: "16px 24px",
              borderRadius: "12px",
              border: "1px solid #374151",
            }}
          >
            <span style={{ fontSize: "24px", marginRight: "12px" }}>💸</span>
            <span style={{ fontSize: "20px", color: "#e5e7eb" }}>Iterate prices</span>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "#222221",
              padding: "16px 24px",
              borderRadius: "12px",
              border: "1px solid #374151",
            }}
          >
            <span style={{ fontSize: "24px", marginRight: "12px" }}>⚡</span>
            <span style={{ fontSize: "20px", color: "#e5e7eb" }}>Real-time insights</span>
          </div>
        </div>
      )}

      {/* Footer with subtle branding */}
      <div
        style={{
          position: "absolute",
          bottom: "40px",
          fontSize: "18px",
          color: "#6b7280",
        }}
      >
        Powered by Unprice
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: "Geist",
          data: font,
          style: "normal",
        },
      ],
    }
  )
}
