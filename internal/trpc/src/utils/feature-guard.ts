import { TRPCError } from "@trpc/server"
import { unprice } from "./unprice"

/**
 * Shared logic for verifying feature access across procedures.
 * Uses UnPrice's own product to manage feature access internally,
 * rather than setting up the UnPrice SDK.
 *
 * @returns Promise resolving to a compatibility shape used by existing TRPC routes.
 */
export const featureGuard = async (params: {
  /** The UnPrice customer ID to check feature access for */
  customerId: string
  /** The feature slug to verify access to */
  featureSlug: string
  /** The usage to check feature access for */
  usage?: number
  /** Whether this is an internal workspace with unlimited access. Defaults to false */
  isMain?: boolean
  /** Metadata to include in the feature verification. Defaults to an empty object */
  metadata?: Record<string, string | undefined>
  /** The action being performed (e.g., 'read', 'write', 'delete'). Normalized to lowercase with spaces as hyphens. */
  action?: string
}): Promise<{
  success: boolean
  deniedReason?: string
  featureType?: string
  status?: string
}> => {
  const { customerId, featureSlug, isMain = false } = params

  // internal workspaces have unlimited access to all features
  if (isMain) {
    return {
      success: true,
      featureType: "flat",
      status: "non_usage",
    }
  }

  try {
    // NOTE: verify no longer accepts metadata/usage/action in the current API contract.
    // Keep those params in the featureGuard signature for route compatibility.
    const data = await unprice.customers.verify({
      customerId,
      featureSlug,
    })

    if (data.error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: data.error.message,
      })
    }

    // Compatibility mapping for existing call sites:
    // - deniedReason no longer exists, use message/status when denied
    // - featureType no longer exists, infer "usage" vs "flat" from verify status
    const inferredFeatureType = data.result.status === "usage" ? "usage" : "flat"
    const deniedReason = data.result.allowed
      ? undefined
      : (data.result.message ?? data.result.status ?? undefined)

    return {
      success: data.result.allowed,
      deniedReason,
      featureType: inferredFeatureType,
      status: data.result.status,
    }
  } catch (e) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: e instanceof Error ? e.message : "Error checking feature access",
    })
  }
}
