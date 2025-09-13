import type { Logger } from "@unprice/logging"
import type { SubscriptionContext } from "./types"

/**
 * Guard: Check if subscription can be renewed using context data
 */
export const canRenew = (input: { context: SubscriptionContext }): boolean => {
  const { subscription, now } = input.context

  // cannot renew if the phase is scheduled to end
  if (subscription.endAt && subscription.endAt < now) return false

  // cannot renew if the renew at is not set
  if (!subscription.renewAt) return false

  // cannot renew if the renew at is not due yet
  return now >= subscription.renewAt
}

export const isAutoRenewEnabled = (input: { context: SubscriptionContext }): boolean => {
  const currentPhase = input.context.currentPhase

  if (!currentPhase) return false

  return currentPhase.planVersion.autoRenew
}

export const isAdvanceBilling = (input: { context: SubscriptionContext }): boolean => {
  const currentPhase = input.context.currentPhase
  if (!currentPhase) return false
  return currentPhase.planVersion.whenToBill === "pay_in_advance"
}

export const isSubscriptionActive = (input: { context: SubscriptionContext }): boolean => {
  return input.context.subscription.active
}

/**
 * Guard: Check if trial period has expired
 */
export const isTrialExpired = (input: { context: SubscriptionContext }): boolean => {
  if (!input.context.currentPhase) return false
  const now = input.context.now
  const trialEndsAt = input.context.currentPhase.trialEndsAt

  if (!trialEndsAt) {
    return false
  }

  if (trialEndsAt > now) {
    return false
  }

  return true
}

export const hasDueBillingPeriods = (input: { context: SubscriptionContext }): boolean => {
  return input.context.hasDueBillingPeriods
}

export const hasValidPaymentMethod = (input: {
  context: SubscriptionContext
  logger: Logger
}): boolean => {
  const paymentMethodId = input.context.paymentMethodId
  const requiredPaymentMethod = input.context.requiredPaymentMethod

  if (!requiredPaymentMethod) return true

  return paymentMethodId !== null
}

export const isCurrentPhaseNull = (input: { context: SubscriptionContext }): boolean => {
  const currentPhase = input.context.currentPhase

  return !currentPhase?.id
}
