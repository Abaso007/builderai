import { redirect } from "next/navigation"

import { getSession } from "@unprice/auth/server-rsc"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { env } from "~/env"
import { SignInGithub } from "../_components/github-signin"
import { SignInGoogle } from "../_components/google-signin"
import { UpdateMarketingCookie } from "../_components/update-marketing-cookie"
import { SignInCredentials } from "./credentials-signin"

export default async function AuthenticationPage({
  searchParams: { sessionId },
}: {
  searchParams: {
    sessionId?: string
  }
}) {
  // TODO: report to analytics with sessionId
  const session = await getSession()

  if (session?.user?.id) {
    redirect("/")
  }

  return (
    <div className={cn("flex flex-col gap-6")}>
      <UpdateMarketingCookie sessionId={sessionId} />
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>Login with your Github or Google account</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex w-full flex-col items-center justify-between gap-4">
            <SignInGithub />
            <SignInGoogle />
          </div>
          {env.NODE_ENV === "development" && (
            <>
              <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-border after:border-t">
                <span className="relative z-10 bg-card px-2 text-muted-foreground">
                  Or continue with
                </span>
              </div>
              <SignInCredentials />

              <div className="text-center text-sm">
                Don&apos;t have an account?{" "}
                <a href="/auth/signup" className="underline underline-offset-4">
                  Sign up
                </a>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <div className="text-balance text-center text-muted-foreground text-xs [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary ">
        By clicking continue, you agree to our{" "}
        <a href="/terms" className="underline underline-offset-4 hover:text-primary">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="/privacy" className="underline underline-offset-4 hover:text-primary">
          Privacy Policy
        </a>
        .
      </div>
    </div>
  )
}
