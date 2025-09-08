import { NoopTinybird, Tinybird } from "@jhonsfran/zod-bird"
import { z } from "zod"
import {
  type AnalyticsEventAction,
  analyticsEventSchema,
  auditLogSchemaV1,
  featureUsageSchemaV1,
  featureVerificationSchemaV1,
  pageEventSchema,
  schemaFeature,
  schemaPlanClick,
  schemaPlanVersion,
  schemaPlanVersionFeature,
} from "./validators"

export class Analytics {
  public readonly readClient: Tinybird | NoopTinybird
  public readonly writeClient: Tinybird | NoopTinybird
  public readonly isNoop: boolean

  constructor(opts: {
    emit: boolean
    tinybirdToken?: string
    tinybirdUrl: string
    tinybirdProxy?: {
      url: string
      token: string
    }
  }) {
    this.readClient =
      opts.tinybirdToken && opts.emit
        ? new Tinybird({ token: opts.tinybirdToken, baseUrl: opts.tinybirdUrl })
        : new NoopTinybird()

    // TODO: implement delete endpoint https://www.tinybird.co/docs/api-reference/datasource-api#delete--v0-datasources-(.+)
    this.writeClient =
      opts.tinybirdProxy && opts.emit
        ? new Tinybird({
            token: opts.tinybirdProxy.token,
            baseUrl: opts.tinybirdProxy.url,
          })
        : this.readClient

    this.isNoop = this.writeClient instanceof NoopTinybird
  }

  public get ingestSdkTelemetry() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "sdk_telemetry",
      event: z.object({
        runtime: z.string(),
        platform: z.string(),
        versions: z.array(z.string()),
        requestId: z.string(),
        time: z.number(),
      }),
    })
  }

  public get ingestGenericAuditLogs() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "audit_logs__v2",
      event: auditLogSchemaV1.transform((l) => ({
        ...l,
        meta: l.meta ? JSON.stringify(l.meta) : undefined,
        actor: {
          ...l.actor,
          meta: l.actor.meta ? JSON.stringify(l.actor.meta) : undefined,
        },
        resources: JSON.stringify(l.resources),
      })),
    })
  }

  public get ingestFeaturesVerification() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_feature_verifications",
      event: featureVerificationSchemaV1,
      // we need to wait for the ingestion to be done before returning
      wait: true,
    })
  }

  public get ingestFeaturesUsage() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_feature_usage_records",
      event: featureUsageSchemaV1,
      // we need to wait for the ingestion to be done before returning
      wait: true,
    })
  }

  public get ingestEvents() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_events",
      event: analyticsEventSchema,
      // we need to wait for the ingestion to be done before returning
      wait: true,
    })
  }

  public get ingestFeatures() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_features",
      event: schemaFeature,
    })
  }

  public get ingestPlanVersionFeatures() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_plan_version_features",
      event: schemaPlanVersionFeature,
    })
  }

  public get ingestPageEvents() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_page_hits",
      event: pageEventSchema,
    })
  }

  public get ingestPlanVersions() {
    return this.writeClient.buildIngestEndpoint({
      datasource: "unprice_plan_versions",
      event: schemaPlanVersion,
    })
  }

  // analytics pages
  public get getPlanClickBySessionId() {
    return this.readClient.buildPipe({
      pipe: "v1_get_session_event",
      parameters: z.object({
        session_id: z.string(),
        action: z.literal("plan_click"),
        interval_days: z.number().optional(),
      }),
      data: z.object({
        timestamp: z.coerce.date(),
        session_id: z.string(),
        payload: z.string().transform((payload) => schemaPlanClick.parse(JSON.parse(payload))),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics events
  public get getLatestEvents() {
    return this.readClient.buildPipe({
      pipe: "v1_get_latest_events",
      parameters: z.object({
        action: z.custom<AnalyticsEventAction>().optional(),
        project_id: z.string().optional(),
        interval_days: z.number().optional(),
      }),
      data: z.object({
        timestamp: z.coerce.date(),
        action: z.string(),
        session_id: z.string(),
        payload: z.string(),
      }),
    })
  }

  // analytics pages
  public get getPlansConversion() {
    return this.readClient.buildPipe({
      pipe: "v1_get_plans_conversion",
      parameters: z.object({
        intervalDays: z.number().optional(),
        projectId: z.string().optional(),
      }),
      data: z.object({
        page_id: z.string(),
        plan_version_id: z.string(),
        plan_views: z.number(),
        plan_clicks: z.number(),
        plan_signups: z.number(),
        conversion: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics pages
  public get getBrowserVisits() {
    return this.readClient.buildPipe({
      pipe: "v1_get_top_browsers",
      parameters: z.object({
        intervalDays: z.number().optional(),
        page_id: z.string().optional(),
        project_id: z.string().optional(),
      }),
      data: z.object({
        page_id: z.string(),
        browser: z.string(),
        visits: z.number(),
        hits: z.number(),
      }),
      opts: {
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics pages
  public get getCountryVisits() {
    return this.readClient.buildPipe({
      pipe: "v1_get_top_countries",
      parameters: z.object({
        intervalDays: z.number().optional(),
        page_id: z.string().optional(),
        project_id: z.string().optional(),
      }),
      data: z.object({
        page_id: z.string(),
        country: z.string(),
        visits: z.number(),
        hits: z.number(),
      }),
      opts: {
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getPagesOverview() {
    return this.readClient.buildPipe({
      pipe: "v1_get_pages_overview",
      parameters: z.object({
        intervalDays: z.number().optional(),
        pageId: z.string().optional(),
        projectId: z.string().optional(),
      }),
      data: z.object({
        date: z.coerce.date(),
        page_id: z.string(),
        desktop_visits: z.number(),
        mobile_visits: z.number(),
        other_visits: z.number(),
        desktop_hits: z.number(),
        mobile_hits: z.number(),
        other_hits: z.number(),
        total_visits: z.number(),
        total_hits: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics features
  public get getFeaturesOverview() {
    return this.readClient.buildPipe({
      pipe: "v1_get_features_overview",
      parameters: z.object({
        intervalDays: z.number().optional(),
        projectId: z.string().optional(),
        timezone: z.string().optional(),
      }),
      data: z.object({
        date: z.coerce.date(),
        latency: z.number(),
        verifications: z.number(),
        usage: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getFeaturesVerifications() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_verifications",
      parameters: z.object({
        projectId: z.string().optional(),
        customerId: z.string().optional(),
        entitlementId: z.string().optional(),
        featureSlug: z.string().optional(),
        intervalDays: z.number().optional(),
      }),
      data: z.object({
        projectId: z.string(),
        customerId: z.string().optional(),
        entitlementId: z.string().optional(),
        featureSlug: z.string(),
        count: z.number(),
        p50_latency: z.number(),
        p95_latency: z.number(),
        p99_latency: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics verifications
  public get getFeaturesVerificationRegions() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_verification_regions",
      parameters: z.object({
        intervalDays: z.number().optional(),
        projectId: z.string(),
        timezone: z.string().optional(),
        region: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
      data: z.object({
        date: z.coerce.date(),
        region: z.string(),
        count: z.number(),
        p50_latency: z.number(),
        p95_latency: z.number(),
        p99_latency: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics usage
  public get getFeaturesUsagePeriod() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_period",
      parameters: z.object({
        projectId: z.string(),
        customerId: z.string().optional(),
        entitlementId: z.string().optional(),
        intervalDays: z.number().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
      data: z.object({
        projectId: z.string(),
        customerId: z.string().optional(),
        entitlementId: z.string().optional(),
        featureSlug: z.string(),
        count: z.number(),
        sum: z.number(),
        max: z.number(),
        last_during_period: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // analytics usage
  public get getFeaturesUsageTotal() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_total",
      parameters: z.object({
        projectId: z.string(),
        customerId: z.string(),
        entitlementIds: z.array(z.string()),
      }),
      data: z.object({
        projectId: z.string(),
        customerId: z.string(),
        entitlementId: z.string(),
        featureSlug: z.string(),
        count_all: z.number(),
        sum_all: z.number(),
        max_all: z.number(),
        last_during_period: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getBillingUsage() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_usage_no_duplicates",
      parameters: z.object({
        entitlementIds: z.array(z.string()).optional(),
        subscriptionItemIds: z.array(z.string()).optional(),
        customerId: z.string(),
        projectId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
      data: z.object({
        projectId: z.string(),
        customerId: z.string(),
        entitlementId: z.string().optional(),
        subscriptionItemId: z.string().optional(),
        featureSlug: z.string(),
        sum_all: z.number().optional(),
        max_all: z.number().optional(),
        count_all: z.number().optional(),
        sum: z.number().optional(),
        max: z.number().optional(),
        count: z.number().optional(),
        last_during_period: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  public get getFeatureHeatmap() {
    return this.readClient.buildPipe({
      pipe: "v1_get_feature_heatmap",
      parameters: z.object({
        projectId: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
        intervalDays: z.number().optional(),
      }),
      data: z.object({
        plan_slug: z.string(),
        feature_slug: z.string(),
        project_id: z.string(),
        usage_count: z.number(),
        usage_sum: z.number(),
        verification_count: z.number(),
        activity_score: z.number(),
      }),
      opts: {
        cache: "no-store",
        retries: 3,
        timeout: 5000, // 5 seconds
      },
    })
  }

  // TODO: create analytics service interface in services/src/analytics/service.ts
  // TODO: add telemtry for this endpoint to know how many times it's being called and the latency
  public async getUsageBillingEntitlements({
    customerId,
    projectId,
    entitlements,
    startAt,
    endAt,
    includeAccumulatedUsage,
  }: {
    customerId: string
    projectId: string
    entitlements: {
      entitlementId: string
      aggregationMethod: string
      featureType: string
    }[]
    startAt: number
    endAt: number
    includeAccumulatedUsage: boolean
  }): Promise<{ entitlementId: string; usage: number; accumulatedUsage: number }[] | null> {
    // filter that only usage, package and tier features are being requested
    const entitlementsUsage = entitlements.filter((entitlement) =>
      ["usage", "package", "tier"].includes(entitlement.featureType)
    )

    const entitlementIdsArray = entitlementsUsage.map((entitlement) => entitlement.entitlementId)

    if (entitlementIdsArray.length === 0) {
      return []
    }

    // we use the same endpoint for billing usage as it's the
    // more accurate one
    const [totalAccumulatedUsages, totalPeriodUsages] = await Promise.all([
      includeAccumulatedUsage
        ? this.getBillingUsage({ customerId, projectId, entitlementIds: entitlementIdsArray })
            .then((usage) => usage.data ?? [])
            .catch((error) => {
              console.error("error getting features usage total", error)
              return null
            })
        : Promise.resolve([]),
      this.getBillingUsage({
        customerId,
        projectId,
        entitlementIds: entitlementIdsArray,
        start: startAt,
        end: endAt,
      })
        .then((usage) => usage.data ?? [])
        .catch((error) => {
          console.error("error getting features usage period", error)
          return null
        }),
    ])

    // if there was an error, return null
    if (!totalPeriodUsages || !totalAccumulatedUsages) {
      return null
    }

    const result = []

    // iterate over the entitlements
    for (const entitlement of entitlements) {
      let accumulatedUsage = 0
      let usage = 0
      const aggregationMethod = entitlement.aggregationMethod
      const isAccumulated = entitlement.aggregationMethod.endsWith("_all")

      const totalUsage = totalPeriodUsages.find(
        (usage) => usage.entitlementId === entitlement.entitlementId
      )
      const totalAccumulatedUsage = totalAccumulatedUsages.find(
        (usage) => usage.entitlementId === entitlement.entitlementId
      )

      if (totalUsage) {
        usage = (totalUsage[aggregationMethod as keyof typeof totalUsage] as number) ?? 0
      }

      // if the aggregation method is _all, we get the usage for all time
      if (totalAccumulatedUsage && isAccumulated) {
        accumulatedUsage =
          (totalAccumulatedUsage[
            aggregationMethod as keyof typeof totalAccumulatedUsage
          ] as number) ?? 0
      }

      result.push({
        entitlementId: entitlement.entitlementId,
        accumulatedUsage,
        usage,
      })
    }

    return result
  }

  public async getUsageBillingSubscriptionItems({
    customerId,
    projectId,
    subscriptionItems,
    startAt,
    endAt,
  }: {
    customerId: string
    projectId: string
    subscriptionItems: {
      subscriptionItemId: string
      aggregationMethod: string
      featureType: string
    }[]
    startAt: number
    endAt: number
  }): Promise<{ subscriptionItemId: string; usage: number; accumulatedUsage: number }[] | null> {
    // filter that only usage, package and tier features are being requested
    const subscriptionItemsUsage = subscriptionItems.filter((subscriptionItem) =>
      ["usage", "package", "tier"].includes(subscriptionItem.featureType)
    )

    const subscriptionItemIdsArray = subscriptionItemsUsage.map(
      (subscriptionItem) => subscriptionItem.subscriptionItemId
    )

    if (subscriptionItemIdsArray.length === 0) {
      return []
    }

    // we use the same endpoint for billing usage as it's the
    // more accurate one
    const [totalAccumulatedUsages, totalPeriodUsages] = await Promise.all([
      this.getBillingUsage({ customerId, projectId, subscriptionItemIds: subscriptionItemIdsArray })
        .then((usage) => usage.data ?? [])
        .catch((error) => {
          console.info("error getting features usage total", error)
          return null
        }),
      this.getBillingUsage({
        customerId,
        projectId,
        subscriptionItemIds: subscriptionItemIdsArray,
        start: startAt,
        end: endAt,
      })
        .then((usage) => usage.data ?? [])
        .catch((error) => {
          console.info("error getting features usage period", error)
          return null
        }),
    ])

    // if there was an error, return null
    if (!totalPeriodUsages || !totalAccumulatedUsages) {
      return null
    }

    // if there are no usages, return an empty array
    if (totalPeriodUsages.length === 0 || totalAccumulatedUsages.length === 0) {
      return []
    }

    const result = []

    // iterate over the entitlements
    for (const subscriptionItem of subscriptionItems) {
      let accumulatedUsage = 0
      let usage = 0
      const aggregationMethod = subscriptionItem.aggregationMethod

      const totalUsage = totalPeriodUsages.find(
        (usage) => usage.subscriptionItemId === subscriptionItem.subscriptionItemId
      )
      const totalAccumulatedUsage = totalAccumulatedUsages.find(
        (usage) => usage.subscriptionItemId === subscriptionItem.subscriptionItemId
      )

      if (totalUsage) {
        usage = (totalUsage[aggregationMethod as keyof typeof totalUsage] as number) ?? 0
      }

      if (totalAccumulatedUsage) {
        accumulatedUsage =
          (totalAccumulatedUsage[
            aggregationMethod as keyof typeof totalAccumulatedUsage
          ] as number) ?? 0
      }

      result.push({
        subscriptionItemId: subscriptionItem.subscriptionItemId,
        accumulatedUsage,
        usage,
      })
    }

    return result
  }
}
