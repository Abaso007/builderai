"use client"

import { useEffect } from "react"
import { type UserJotUser, useUserJot } from "~/hooks/use-userjot"

export function UserJotButton({ user }: { user: UserJotUser | null }) {
  const { identify } = useUserJot()

  useEffect(() => {
    if (user) {
      identify({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
      })
    } else {
      identify(null) // Logs them out of UserJot too
    }
  }, [user])

  return null
}
