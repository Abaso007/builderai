"use client"

import type { UseFormReturn } from "react-hook-form"

import type { Currency, PlanVersionFeature } from "@builderai/db/validators"

import { PriceFormField } from "./fields-form"

export function FlatFormFields({
  form,
  currency,
}: {
  form: UseFormReturn<PlanVersionFeature>
  currency: Currency
}) {
  return (
    <div className="flex flex-col">
      <PriceFormField form={form} currency={currency} />
    </div>
  )
}
