import { useEffect, useState } from "react"

export interface UserJotUser {
  id: string
  email?: string
  firstName?: string
  lastName?: string
  avatar?: string
}

export function useUserJot() {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => {
      // @ts-ignore - window.uj is global from the script
      setIsOpen(window.uj?.getWidgetState()?.isOpen ?? false)
    }, 500)
    return () => clearInterval(interval)
  }, [])

  const show = (section?: "feedback" | "roadmap" | "updates") =>
    // biome-ignore lint/suspicious/noExplicitAny: window.uj is global from the script
    (window as any).uj?.showWidget({ section })

  const hide = () =>
    // biome-ignore lint/suspicious/noExplicitAny: window.uj is global from the script
    (window as any).uj?.hideWidget()

  const identify = (user: UserJotUser | null) =>
    // biome-ignore lint/suspicious/noExplicitAny: window.uj is global from the script
    (window as any).uj?.identify(user)

  return { isOpen, show, hide, identify }
}
