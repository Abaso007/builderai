import { Logo } from "~/components/layout/logo"

export default function AuthLayout(props: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex gap-2 self-center">
          <Logo size="lg" />
        </div>
        {props.children}
      </div>
    </div>
  )
}
