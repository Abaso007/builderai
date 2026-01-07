"use client"

import { Button, type ButtonProps } from "@unprice/ui/button"
import { GitHub, Google, Spinner } from "@unprice/ui/icons"
import { useFormStatus } from "react-dom"

interface AuthButtonProps extends ButtonProps {
  children: React.ReactNode
  provider: "github" | "google" | "none"
}

export function AuthButton({ children, provider, ...props }: AuthButtonProps) {
  const { pending } = useFormStatus()

  const Icon = provider === "github" ? GitHub : provider === "google" ? Google : null

  return (
    <Button className="w-full" variant="default" type="submit" disabled={pending} {...props}>
      {pending ? (
        <Spinner className="mr-2 size-4 animate-spin" />
      ) : (
        Icon && <Icon className="mr-2 size-4" />
      )}
      {children}
    </Button>
  )
}
