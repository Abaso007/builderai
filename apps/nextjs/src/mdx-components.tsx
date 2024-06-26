import type { MDXComponents } from "mdx/types"
import type { Route } from "next"
import Link from "next/link"

// This file is required to use MDX in `app` directory.
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    // Allows customizing built-in components, e.g. to add styling.
    h1: (props) => (
      <h1 className="font-primary mt-10 scroll-m-20 text-4xl" {...props}>
        {props.children}
      </h1>
    ),
    h2: (props) => (
      <h2 className="font-primary mt-10 scroll-m-20 border-b pb-2 text-3xl first:mt-0" {...props}>
        {props.children}
      </h2>
    ),
    h3: (props) => (
      <h3 className="font-primary mt-8 scroll-m-20 text-2xl" {...props}>
        {props.children}
      </h3>
    ),
    h4: (props) => (
      <h4 className="font-primary -mb-4 mt-6 scroll-m-20 text-2xl" {...props}>
        {props.children}
      </h4>
    ),
    p: (props) => <p className="leading-7 [&:not(:first-child)]:mt-6" {...props} />,
    a: ({ children, href }) => {
      const isExternal = href?.startsWith("http")
      const Component = isExternal ? "a" : Link
      return (
        <Component
          href={href as Route}
          className="decoration-primary underline decoration-2 underline-offset-4"
        >
          {children}
        </Component>
      )
    },
    ul: (props) => <ul className="mt-4 list-disc pl-8" {...props} />,
    code: (props) => (
      <code
        className="bg-muted text-muted-foreground relative rounded px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold"
        {...props}
      />
    ),
    img: (props) => <img {...props} className="rounded-lg" alt={props.alt} />,

    // Pass through all other components.
    ...components,
  }
}
