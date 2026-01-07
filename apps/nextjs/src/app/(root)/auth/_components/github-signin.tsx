import { signIn } from "@unprice/auth/server"
import { APP_DOMAIN } from "@unprice/config"
import { cn } from "@unprice/ui/utils"
import { AuthButton } from "./auth-button"

export function SignInGithub({
  className,
  redirectTo,
}: { className?: string; redirectTo?: string }) {
  return (
    <form className={cn("w-full", className)}>
      <AuthButton
        provider="github"
        formAction={async () => {
          "use server"
          await signIn("github", {
            redirectTo: redirectTo ?? APP_DOMAIN,
          })
        }}
      >
        Github
      </AuthButton>
    </form>
  )
}
