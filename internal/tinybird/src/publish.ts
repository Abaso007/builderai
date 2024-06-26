import { tb } from "./client"
import { ClickHitsSchema, eventSchema, pageSchema, usageSchema } from "./validators"

export const publishClickHits = tb.buildIngestEndpoint({
  datasource: "click_hits__v1",
  event: ClickHitsSchema,
})

export const publishPageViews = tb.buildIngestEndpoint({
  datasource: "page_views__v1",
  event: pageSchema,
})

export const publishEvents = tb.buildIngestEndpoint({
  datasource: "events__v1",
  event: eventSchema,
})

export const reportUsage = tb.buildIngestEndpoint({
  datasource: "usage__v1",
  event: usageSchema,
})
