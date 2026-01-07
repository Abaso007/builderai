import { signOut } from "@unprice/auth/server"

import { AUTH_ROUTES } from "@unprice/config"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { AuthButton } from "../_components/auth-button"

export default function AuthenticationPage() {
  return (
    <div className={cn("flex flex-col gap-6")}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign Out</CardTitle>
          <CardDescription>Are you sure you want to sign out?</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex w-full flex-col items-center justify-between gap-4">
            <div className="flex w-full flex-col gap-2">
              <AuthButton
                provider="none"
                className="w-full"
                variant="destructive"
                formAction={async () => {
                  "use server"
                  await signOut({
                    redirect: true,
                    redirectTo: AUTH_ROUTES.SIGNIN,
                  })
                }}
              >
                Confirm
              </AuthButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
