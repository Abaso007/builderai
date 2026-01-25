import { z } from "zod"
import type { Logger } from "./interface"

export const wideEventSchema = z
  .object({
    infra: z
      .object({
        // Infrastructure context
        platform: z.string(),
        durableObjectId: z.string().optional(),
        isolateId: z.string().optional(),
        isolateLifetime: z.number().optional(),
      })
      .passthrough()
      .optional(),
    business: z
      .object({
        // Business context
        userId: z.string().optional(),
        customerId: z.string().optional(),
        projectId: z.string().optional(),
        workspaceId: z.string().optional(),
        featureSlug: z.string().optional(),
        operation: z.string().optional(),
        usage: z.number().optional(),
        isMain: z.boolean().optional(),
        isInternal: z.boolean().optional(),
        unPriceCustomerId: z.string().optional(),
        version: z.string().optional(),
        activeWorkspaceSlug: z.string().optional(),
        activeProjectSlug: z.string().optional(),
      })
      .passthrough()
      .optional(),
    rateLimited: z.boolean().optional(),
    // Outcome context
    outcome: z.enum(["success", "error", "denied"]).optional(),
    deniedReason: z.string().optional(),
    errorType: z.string().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    // Finalized by middleware
    status: z.number().optional(),
    duration: z.number().optional(),
    timestamp: z.string().datetime().optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    host: z.string().optional(),
  })
  .passthrough()

export type WideEventContext = z.infer<typeof wideEventSchema>

export class WideEvent {
  // We hold the raw data object directly
  private data: Partial<WideEventContext>
  private logger: Logger
  private sampleRate: number

  constructor(logger: Logger, base: WideEventContext, sampleRate = 0.1) {
    this.data = base
    this.logger = logger
    this.sampleRate = sampleRate
  }

  /**
   * Fast, non-validating add.
   * Validation overhead here is unnecessary for 99% of apps.
   * Automatically merges nested objects (business, infra, geo) instead of replacing them.
   */
  public add<K extends keyof WideEventContext>(key: K, value: WideEventContext[K]) {
    const currentValue = this.data[key]
    // If both current and new values are objects, merge them
    if (
      currentValue &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      this.data[key] = { ...currentValue, ...value } as WideEventContext[K]
    } else {
      // Direct assignment for primitives or when replacing
      this.data[key] = value
    }
  }

  /**
   * Bulk merge for convenience
   */
  public addContext(context: Partial<WideEventContext>) {
    Object.assign(this.data, context)
  }

  public get(): WideEventContext {
    return this.data as WideEventContext
  }

  /**
   * Sampling Logic
   */
  public shouldSample(): boolean {
    const status = this.data.status || 200

    // 1. Always keep errors
    if (status >= 400) return true

    // 2. Always keep slow requests (> 1s)
    if ((this.data.duration || 0) > 1000) return true

    // 3. Sample 10% of healthy traffic
    return Math.random() < this.sampleRate
  }

  public toJSON() {
    return this.data
  }

  public log() {
    const shouldSample = this.shouldSample()
    if (shouldSample) {
      if (this.data.status && this.data.status >= 400) {
        if (this.data.status === 429) {
          // rate limited
          this.logger.log("warn", "wide_event", this.data)
        } else {
          this.logger.log("error", "wide_event", this.data)
        }
      } else {
        this.logger.log("info", "wide_event", this.data)
      }
    }
  }
}
