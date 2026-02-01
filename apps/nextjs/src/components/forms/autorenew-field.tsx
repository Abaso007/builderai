"use client"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"

interface FormValues extends FieldValues {
  autoRenew?: boolean
}

export default function AutoRenewFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  return (
    <FormField
      control={form.control}
      name={"autoRenew" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className="flex w-full flex-col">
          <div className="flex items-center gap-1">
            <FormLabel>Auto Renew</FormLabel>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[250px]">
                When enabled, the subscription automatically renews at the end of each billing
                cycle.
              </TooltipContent>
            </Tooltip>
          </div>
          <Select
            onValueChange={(value) => field.onChange(value === "true")}
            value={field.value?.toString() ?? "true"}
            disabled={isDisabled}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue
                  placeholder="Select auto-renewal"
                  defaultValue={field.value?.toString() ?? "true"}
                />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="true">Yes</SelectItem>
              <SelectItem value="false">No</SelectItem>
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
