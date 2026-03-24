import { render } from "@react-email/render"
import { Resend } from "resend"
import { env } from "./env"

const resendApiKey = env.RESEND_API_KEY?.trim()
const resend = resendApiKey ? new Resend(resendApiKey) : null

const RESEND_DEFAULT_FROM_EMAIL = "Seb from Unprice <seb@unprice.dev>"
const MISSING_RESEND_API_KEY_ERROR =
  "RESEND_API_KEY is missing. Configure it to send emails outside development."

// Lazy load nodemailer only when needed (development + server)
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
let mailpitTransporter: any = null

async function getMailpitTransporter() {
  if (!mailpitTransporter) {
    const nodemailer = await import("nodemailer") // Dynamic import
    mailpitTransporter = nodemailer.createTransport({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      ignoreTLS: true,
    })
  }
  return mailpitTransporter
}

interface Emails {
  react: JSX.Element
  subject: string
  to: string[]
  from?: string
}

interface EmailHtml {
  html: string
  subject: string
  to: string[]
  from?: string
}

// --- Main React Email Sender ---
export const sendEmail = async ({
  react,
  subject,
  to,
  from = RESEND_DEFAULT_FROM_EMAIL,
}: Emails) => {
  const html = await render(react)
  const text = await render(react, { plainText: true })

  if (env.NODE_ENV === "development") {
    try {
      const transporter = await getMailpitTransporter()
      const info = await transporter.sendMail({ from, to, subject, html, text })
      return { data: info, error: null }
    } catch (error) {
      console.error("Error sending email to Mailpit:", error)
      return { data: null, error }
    }
  }

  if (!resend) {
    return { data: null, error: new Error(MISSING_RESEND_API_KEY_ERROR) }
  }

  try {
    return await resend.emails.send({ react, subject, to, from })
  } catch (error) {
    return { data: null, error }
  }
}

// --- Pre-rendered HTML Email Sender ---
export const sendEmailHtml = async ({
  html,
  subject,
  to,
  from = RESEND_DEFAULT_FROM_EMAIL,
}: EmailHtml) => {
  if (env.NODE_ENV === "development") {
    try {
      const transporter = await getMailpitTransporter()
      const info = await transporter.sendMail({ from, to, subject, html })
      console.info("Pre-rendered HTML email sent to Mailpit:", info.messageId)
      return { data: info, error: null }
    } catch (error) {
      console.error("Error sending pre-rendered HTML email to Mailpit:", error)
      return { data: null, error }
    }
  }

  if (!resendApiKey) {
    return { data: null, error: new Error(MISSING_RESEND_API_KEY_ERROR) }
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({ to, from, subject, html }),
    })

    if (!res.ok) {
      throw new Error(`Failed to send email via Resend: ${res.statusText}`)
    }

    const data = await res.json()
    return { data, error: null }
  } catch (error) {
    return { data: null, error }
  }
}
