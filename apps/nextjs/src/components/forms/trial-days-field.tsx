"use client"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { cn } from "@unprice/ui/utils"
import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { InputWithAddons } from "~/components/input-addons"

interface FormValues extends FieldValues {
  trialUnits?: number
}

export default function TrialUnitsFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
  className,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
  className?: string
}) {
  return (
    <FormField
      control={form.control}
      name={"trialUnits" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className={cn("flex w-full flex-col", className)}>
          <FormLabel>Trial Units</FormLabel>
          <FormDescription>The number of units trial for the phase.</FormDescription>
          <FormControl className="w-full">
            <InputWithAddons
              {...field}
              trailing={"units"}
              value={field.value ?? 0}
              disabled={isDisabled}
            />
          </FormControl>

          <FormMessage className="self-start pt-1" />
        </FormItem>
      )}
    />
  )
}
