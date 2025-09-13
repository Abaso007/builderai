import { zodResolver } from "@hookform/resolvers/zod"
import type { UseFormProps } from "react-hook-form"
import { useForm } from "react-hook-form"
import type { ZodType } from "zod"

export function useZodForm<TSchema extends ZodType>(
  props: Omit<UseFormProps<TSchema["_output"]>, "resolver"> & {
    schema: TSchema
  }
) {
  const form = useForm<TSchema["_output"]>({
    ...props,
    shouldFocusError: true,
    delayError: 100,
    resolver: zodResolver(props.schema, undefined),
  })

  return form
}
