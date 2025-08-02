import type { Analytics } from "@unprice/analytics"
import type { Database, TransactionDatabase } from "@unprice/db"
import { nFormatter } from "@unprice/db/utils"
import {
  type BillingInterval,
  type Currency,
  type Plan,
  type PlanVersionApi,
  type PlanVersionExtended,
  calculateFlatPricePlan,
  calculateFreeUnits,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { retry } from "../utils/retry"

export class PlanService {
  private readonly db: Database | TransactionDatabase
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void

  private createCacheKey(prefix: string, params: Record<string, unknown>): string {
    // Sort keys to ensure consistent order
    const sortedParams = Object.keys(params)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = params[key]
          return acc
        },
        {} as Record<string, unknown>
      )

    // Create a stable string representation
    const paramsString = JSON.stringify(sortedParams)
      .replace(/["'{}]/g, "")
      .replace(",", "-")

    // Use a separator that's unlikely to appear in the data
    return `${prefix}:${paramsString}`
  }

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  }: {
    db: Database | TransactionDatabase
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.waitUntil = waitUntil
    this.cache = cache
    this.metrics = metrics
  }

  private formatPlanVersion({
    planVersion,
  }: {
    planVersion: PlanVersionExtended & {
      plan: Plan
    }
  }): PlanVersionApi {
    const planFeatures = planVersion.planFeatures.map((planFeature) => {
      let displayFeatureText = ""

      const freeUnits = calculateFreeUnits({
        config: planFeature.config!,
        featureType: planFeature.featureType,
      })

      const freeUnitsText =
        freeUnits === Number.POSITIVE_INFINITY
          ? planFeature.limit
            ? `Up to ${nFormatter(planFeature.limit)}`
            : "Unlimited"
          : freeUnits === 0
            ? planFeature.limit
              ? `Up to ${nFormatter(planFeature.limit)}`
              : ""
            : nFormatter(freeUnits)

      switch (planFeature.featureType) {
        case "flat": {
          displayFeatureText = `${planFeature.feature.title}`
          break
        }

        case "tier": {
          displayFeatureText = `${freeUnitsText} ${planFeature.feature.title}`
          break
        }

        case "usage": {
          displayFeatureText = `${freeUnitsText} ${planFeature.feature.title}`

          break
        }

        case "package": {
          displayFeatureText = `${freeUnitsText} ${planFeature.feature.title}`
          break
        }
      }

      return {
        ...planFeature,
        displayFeatureText,
      }
    })

    // calculate flat price
    // verify if the payment method is required
    const { err, val: totalPricePlan } = calculateFlatPricePlan({
      planVersion,
    })

    if (err) {
      throw err
    }

    return {
      ...planVersion,
      flatPrice: totalPricePlan.displayAmount,
      planFeatures,
    }
  }

  private async getPlanVersionData({
    projectId,
    planVersionId,
  }: {
    projectId?: string
    planVersionId: string
  }): Promise<PlanVersionApi | null> {
    const start = performance.now()

    const planVersionData = await this.db.query.versions
      .findFirst({
        with: {
          plan: true,
          planFeatures: {
            with: {
              feature: true,
            },
            orderBy(fields, operators) {
              return operators.asc(fields.order)
            },
          },
        },
        where: (version, { and, eq }) =>
          and(
            projectId ? eq(version.projectId, projectId) : undefined,
            eq(version.id, planVersionId),
            eq(version.active, true),
            eq(version.status, "published")
          ),
      })
      .catch((err) => {
        throw err
      })

    const end = performance.now()

    this.metrics.emit({
      metric: "metric.db.read",
      query: "getPlanVersion",
      duration: end - start,
      service: "plans",
      projectId,
    })

    if (!planVersionData) {
      return null
    }

    // format plan
    return this.formatPlanVersion({
      planVersion: planVersionData,
    })
  }

  private async listPlanVersionsData({
    projectId,
    query,
  }: {
    projectId: string
    query: {
      published?: boolean
      latest?: boolean
      currency?: Currency
      billingInterval?: BillingInterval
      enterprise?: boolean
    }
  }): Promise<PlanVersionApi[] | null> {
    const { published, latest, currency, enterprise, billingInterval } = query
    const start = performance.now()

    const planVersionsData = await this.db.query.versions
      .findMany({
        with: {
          plan: true,
          planFeatures: {
            with: {
              feature: true,
            },
            orderBy(fields, operators) {
              return operators.asc(fields.order)
            },
          },
        },
        where: (version, { and, eq }) =>
          and(
            eq(version.projectId, projectId),
            eq(version.active, true),
            // get published versions by default, only get unpublished versions if the user wants it
            (published && eq(version.status, "published")) || undefined,
            // latest versions by default, only get non latest versions if the user wants it
            (latest && eq(version.latest, true)) || undefined,
            // filter by currency if provided
            currency ? eq(version.currency, currency) : undefined
          ),
      })
      .then((data) => {
        if (billingInterval) {
          return data.filter((version) => version.billingConfig.billingInterval === billingInterval)
        }

        return data
      })
      .catch((err) => {
        throw err
      })

    const end = performance.now()

    this.metrics.emit({
      metric: "metric.db.read",
      query: "listPlanVersionsData",
      duration: end - start,
      service: "plans",
      projectId,
    })

    if (planVersionsData.length === 0) {
      null
    }

    if (enterprise) {
      planVersionsData.filter((version) => version.plan.enterprisePlan)
    }

    // format every plan
    const result = planVersionsData.map((version) => {
      return this.formatPlanVersion({
        planVersion: version,
      })
    })

    return result
  }

  public async listPlanVersions({
    projectId,
    query,
    opts,
  }: {
    projectId: string
    query: {
      published?: boolean
      latest?: boolean
      currency?: Currency
      billingInterval?: BillingInterval
      enterprise?: boolean
    }
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<PlanVersionApi[] | null, FetchError>> {
    const cachekey = this.createCacheKey(projectId, query)

    // first try to get the entitlement from cache
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.listPlanVersionsData({
            projectId,
            query,
          }),
          (err) =>
            new FetchError({
              message: `unable to query list plans from db, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                projectId,
                method: "listPlanVersions",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.planVersionList.swr(`${cachekey}`, () =>
              this.listPlanVersionsData({
                projectId,
                query,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch list of plans data from cache, retrying...", {
              projectId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting list of plans", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    return Ok(val)
  }

  public async getPlanVersion({
    projectId,
    planVersionId,
    opts,
  }: {
    projectId?: string
    planVersionId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<PlanVersionApi | null, FetchError>> {
    const cachekey = `${planVersionId}`

    // first try to get the entitlement from cache
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getPlanVersionData({
            projectId,
            planVersionId,
          }),
          (err) =>
            new FetchError({
              message: `unable to query get plan from db, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                projectId,
                method: "getPlanVersion",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.planVersion.swr(`${cachekey}`, () =>
              this.getPlanVersionData({
                projectId,
                planVersionId,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch plan version data from cache, retrying...", {
              projectId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting plan version", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    return Ok(val)
  }
}
