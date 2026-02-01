"use client"
import { COLLECTION_METHODS } from "@unprice/db/utils"
import type { CollectionMethod } from "@unprice/db/validators"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"

interface FormValues extends FieldValues {
  collectionMethod?: CollectionMethod | null
}

export default function CollectionMethodFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  return (
    <FormField
      control={form.control}
      name={"collectionMethod" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className="flex w-full flex-col">
          <div className="flex items-center gap-1">
            <FormLabel>Collection Method</FormLabel>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[250px]">
                Choose automatic payment (charges card on file) or invoice-based billing.
              </TooltipContent>
            </Tooltip>
          </div>
          <Select
            onValueChange={field.onChange}
            value={field.value?.toString() ?? ""}
            disabled={isDisabled}
          >
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="Select collection method" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {/* // TODO: add send_invoice to the collection methods */}
              {COLLECTION_METHODS.filter((type) => type !== "send_invoice").map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
