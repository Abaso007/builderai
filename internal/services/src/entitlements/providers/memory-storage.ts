import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { UnPriceEntitlementStorageError } from "../errors"
import type { EntitlementStorageProvider } from "../storage-provider"
import type { EntitlementState } from "../types"

/**
 * Simple Memory client interface
 */
interface MemoryStorage extends Map<string, EntitlementState> {}

/**
 * Simplified Memory Storage Provider
 */
export class MemoryStorageProvider implements EntitlementStorageProvider {
  readonly name = "memory"
  private readonly memory: MemoryStorage
  private readonly logger: Logger

  constructor(opts: { memory: MemoryStorage; logger: Logger }) {
    this.memory = opts.memory
    this.logger = opts.logger
  }

  async get(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<EntitlementState | null, UnPriceEntitlementStorageError>> {
    try {
      const key = this.makeKey(params)
      const value = this.memory.get(key)

      if (!value) return Ok(null)

      return Ok(value as EntitlementState)
    } catch (error) {
      this.logger.error("Memory get failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Get failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  async set(params: { state: EntitlementState }): Promise<
    Result<void, UnPriceEntitlementStorageError>
  > {
    try {
      const key = this.makeKey({
        customerId: params.state.customerId,
        projectId: params.state.projectId,
        featureSlug: params.state.featureSlug,
      })

      this.memory.set(key, params.state)

      return Ok(undefined)
    } catch (error) {
      this.logger.error("Memory set failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Set failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  async delete(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): Promise<Result<void, UnPriceEntitlementStorageError>> {
    try {
      const key = this.makeKey(params)
      this.memory.delete(key)
      return Ok(undefined)
    } catch (error) {
      this.logger.error("Memory delete failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
      return Err(
        new UnPriceEntitlementStorageError({
          message: "Delete failed",
          context: {
            error: error instanceof Error ? error.message : "unknown",
          },
        })
      )
    }
  }

  private makeKey(params: {
    customerId: string
    projectId: string
    featureSlug: string
  }): string {
    return `entitlement:${params.projectId}:${params.customerId}:${params.featureSlug}`
  }
}
