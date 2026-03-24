/**
 * Temporary no-op feature guard.
 * Feature validation is disabled for all TRPC routes.
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
  void params

  return {
    success: true,
    featureType: "flat",
    status: "non_usage",
  }
}
