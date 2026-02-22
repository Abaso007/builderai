import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { Logger, WideEventHelpers } from "@unprice/logging"
import type { Cache } from "@unprice/services/cache"
import type { Metrics } from "@unprice/services/metrics"
import { ProjectService } from "@unprice/services/projects"
import type { GetProjectFeaturesRequest, GetProjectFeaturesResponse } from "./interface"

export class ApiProjectService {
  private readonly logger: Logger
  private readonly metrics: Metrics
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly db: Database
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly projectService: ProjectService
  private wideEventHelpers?: WideEventHelpers

  constructor(opts: {
    requestId: string
    domain?: string
    logger: Logger
    metrics: Metrics
    analytics: Analytics
    cache: Cache
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    db: Database
    wideEventHelpers?: WideEventHelpers
  }) {
    this.logger = opts.logger
    this.metrics = opts.metrics
    this.analytics = opts.analytics
    this.cache = opts.cache
    this.db = opts.db
    this.waitUntil = opts.waitUntil
    this.wideEventHelpers = opts.wideEventHelpers
    this.projectService = new ProjectService({
      logger: this.logger,
      analytics: this.analytics,
      waitUntil: this.waitUntil,
      cache: this.cache,
      metrics: this.metrics,
      db: this.db,
      wideEventHelpers: this.wideEventHelpers,
    })
  }

  /**
   * Sets the wide event helpers for request-scoped logging context.
   * This should be called inside the wideEventLogger.runAsync() context.
   * Propagates to nested services (projectService).
   */
  public setWideEventHelpers(wideEventHelpers: WideEventHelpers) {
    this.wideEventHelpers = wideEventHelpers
    this.projectService.setWideEventHelpers(wideEventHelpers)
  }

  public async getProjectFeatures(
    req: GetProjectFeaturesRequest
  ): Promise<GetProjectFeaturesResponse> {
    const { projectId } = req

    const { err, val } = await this.projectService.getProjectFeatures({
      projectId,
      opts: {
        skipCache: false,
      },
    })

    if (err) {
      throw err
    }

    if (!val) {
      return {
        features: [],
      }
    }

    return {
      features: val.features,
    }
  }
}
