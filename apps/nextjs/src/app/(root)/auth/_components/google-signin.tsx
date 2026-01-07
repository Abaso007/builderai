import { signIn } from "@unprice/auth/server"
import { APP_DOMAIN } from "@unprice/config"
import { cn } from "@unprice/ui/utils"
import { AuthButton } from "./auth-button"

export function SignInGoogle({
  className,
  redirectTo,
}: { className?: string; redirectTo?: string }) {
  return (
    <form className={cn("w-full", className)}>
      <AuthButton
        provider="google"
        formAction={async () => {
          "use server"
          await signIn("google", {
            redirectTo: redirectTo ?? APP_DOMAIN,
          })
        }}
      >
        Google
      </AuthButton>
    </form>
  )
}
