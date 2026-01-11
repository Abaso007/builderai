import { TRPCError } from "@trpc/server"
import { unprice } from "./unprice"

/**
 * Shared logic for verifying feature access across procedures.
 * Uses UnPrice's own product to manage feature access internally,
 * rather than setting up the UnPrice SDK.
 *
 * @returns Promise resolving to {access: boolean, deniedReason: string | null}
 */
export const featureGuard = async ({
  customerId,
  featureSlug,
  usage,
  isMain = false,
  metadata = {},
}: {
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
}): Promise<{
  success: boolean
  deniedReason?: string
  featureType?: string
}> => {
  // internal workspaces have unlimited access to all features
  if (isMain) {
    return {
      success: true,
    }
  }

  try {
    const data = await unprice.customers.can({
      customerId,
      featureSlug,
      metadata,
      usage,
    })

    if (data.error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: data.error.message,
      })
    }

    return {
      success: data.result.allowed,
      deniedReason: data.result.deniedReason ?? undefined,
      featureType: data.result.featureType ?? undefined,
    }
  } catch (e) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: e instanceof Error ? e.message : "Error checking feature access",
    })
  }
}
