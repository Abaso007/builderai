import { Link } from "next-view-transitions"

import { Button } from "@unprice/ui/button"

import { EmptyPlaceholder } from "~/components/empty-placeholder"

export default function NotFound() {
  return (
    <EmptyPlaceholder className="mx-4 my-4">
      <EmptyPlaceholder.Title>404 Not Found</EmptyPlaceholder.Title>
      <EmptyPlaceholder.Description>
        We could not find the page that you are looking for!
      </EmptyPlaceholder.Description>
      <div className="flex flex-col items-center justify-center gap-2 md:flex-row">
        <Link href="/">
          <Button variant="secondary" className="w-full items-center gap-2">
            Go Back
          </Button>
        </Link>
      </div>
    </EmptyPlaceholder>
  )
}
