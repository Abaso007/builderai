"use client"

import { APP_DOMAIN } from "@unprice/config"
import type { PaymentProvider } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { RadioGroup, RadioGroupItem } from "@unprice/ui/radio-group"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { useParams } from "next/navigation"
import type { FieldErrors, FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { PaymentMethodDialog } from "~/components/forms/payment-method-dialog"
import { api } from "~/trpc/client"

interface FormValues extends FieldValues {
  customerId: string
  defaultPaymentMethodId?: string | null
  subscriptionCustomerId?: string | null
}

export default function PaymentMethodsFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
  paymentProvider,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
  paymentProvider: PaymentProvider
}) {
  const workspaceSlug = useParams().workspaceSlug as string
  const projectSlug = useParams().projectSlug as string
  const customerId = form.getValues("customerId" as FieldPath<TFieldValues>)
  const successUrl = `${APP_DOMAIN}/${workspaceSlug}/${projectSlug}/customers/${customerId}`
  const cancelUrl = `${APP_DOMAIN}/${workspaceSlug}/${projectSlug}/customers/${customerId}`

  const { errors } = form.formState

  const { data, isLoading } = api.customers.listPaymentMethods.useQuery(
    {
      customerId: customerId,
      provider: paymentProvider,
    },
    {
      enabled: customerId !== "",
    }
  )

  const hasPaymentMethods = (data?.paymentMethods.length ?? 0) > 0

  // Helper function to safely get the error message
  const getErrorMessage = (
    errors: FieldErrors<TFieldValues>,
    field: string
  ): string | undefined => {
    const error = errors[field as keyof typeof errors]
    return error && typeof error === "object" && "message" in error
      ? (error.message as string)
      : undefined
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-2">
        <FormLabel
          className={cn({
            "text-destructive": errors.defaultPaymentMethodId,
          })}
        >
          <Typography variant="h4" className="my-auto block">
            Payment method
          </Typography>
        </FormLabel>

        <div className="font-normal text-xs leading-snug">
          {"Select the payment method you want to use for this subscription."}
        </div>

        {errors.defaultPaymentMethodId && (
          <FormMessage>{getErrorMessage(errors, "defaultPaymentMethodId")}</FormMessage>
        )}
      </div>
      {hasPaymentMethods && (
        <FormField
          control={form.control}
          name={"defaultPaymentMethodId" as FieldPath<TFieldValues>}
          render={({ field }) => (
            <FormItem className="w-full space-y-1">
              <RadioGroup
                onValueChange={(value) => {
                  field.onChange(value)
                }}
                defaultValue={field.value ?? ""}
                className="flex flex-col gap-4 pt-2"
                disabled={isDisabled}
              >
                {/* // TODO: add payment method link */}
                {data?.paymentMethods.map((method) => (
                  <FormItem key={method.id}>
                    <FormLabel
                      htmlFor={`radio-${method.id}`}
                      className="[&:has([data-state=checked])>div]:border-primary-border [&:has([data-state=checked])>div]:shadow-sm"
                    >
                      <FormControl>
                        <RadioGroupItem
                          id={`radio-${method.id}`}
                          value={method.id}
                          className="sr-only"
                          disabled={isDisabled}
                          checked={field.value === method.id}
                        />
                      </FormControl>
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: <explanation> */}
                      <div
                        onClick={() => {
                          if (isDisabled) return
                          field.onChange(method.id)
                        }}
                        className="cursor-pointer items-center rounded-md border-2 border-muted p-6 hover:border-background-bgActive"
                      >
                        <div className="flex flex-row items-center justify-between">
                          <div className="inline-flex gap-2">
                            <span>{method?.brand}</span>
                            <span>**** **** **** {method?.last4}</span>
                          </div>
                          <div className="inline-flex gap-2">
                            <span>Expires</span>
                            <span>
                              {method?.expMonth?.toLocaleString("en-US", {
                                minimumIntegerDigits: 2,
                              })}
                              /{method?.expYear}
                            </span>
                          </div>
                        </div>
                      </div>
                    </FormLabel>
                  </FormItem>
                ))}
              </RadioGroup>
            </FormItem>
          )}
        />
      )}
      {!hasPaymentMethods && (
        <EmptyPlaceholder isLoading={isLoading} className="min-h-[100px]">
          <EmptyPlaceholder.Description className="mt-0">
            No payment methods found.
          </EmptyPlaceholder.Description>
          <EmptyPlaceholder.Action>
            <PaymentMethodDialog
              customerId={customerId}
              successUrl={successUrl}
              cancelUrl={cancelUrl}
            >
              <Button variant="default" size="sm">
                Add payment method
              </Button>
            </PaymentMethodDialog>
          </EmptyPlaceholder.Action>
        </EmptyPlaceholder>
      )}
    </div>
  )
}
