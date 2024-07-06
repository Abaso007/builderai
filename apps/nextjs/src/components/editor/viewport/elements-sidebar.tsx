import { Logo } from "~/components/layout/logo"

export function ElementsSidebar() {
  const elements = [
    {
      name: "Text",
    },
  ]
  return (
    <nav
      className=
      "left-0 z-40 h-full max-h-screen gap-2 inset-y-0 flex w-64 flex-col xl:w-72">
      <aside className="flex grow flex-col gap-y-6 overflow-y-auto border-r p-4">
        <Logo />
        <nav aria-label="core navigation links" className="flex flex-1 flex-col space-y-10">
          <ul className="space-y-1">
            {elements.map((element) => (
              <li key={element.name}>Testing</li>
            ))}
          </ul>
        </nav>
      </aside>
    </nav>
  )
}
