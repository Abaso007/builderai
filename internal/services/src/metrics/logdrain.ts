import type { Logger } from "@unprice/logging"
import { Log, type LogSchema } from "@unprice/logs"
import type { Metric } from "@unprice/metrics"
import type { Metrics } from "./interface"

export class LogdrainMetrics implements Metrics {
  private requestId: string
  private readonly logger: Logger
  private readonly environment: LogSchema["environment"]
  private readonly service: LogSchema["service"]
  private colo?: string
  private country?: string
  private continent?: string
  private durableObjectId?: string

  constructor(opts: {
    requestId: string
    logger: Logger
    environment: LogSchema["environment"]
    service: LogSchema["service"]
    colo?: string
    country?: string
    continent?: string
    durableObjectId?: string
  }) {
    this.requestId = opts.requestId
    this.logger = opts.logger
    this.environment = opts.environment
    this.service = opts.service
    this.colo = opts.colo
    this.country = opts.country
    this.continent = opts.continent
    this.durableObjectId = opts.durableObjectId
  }

  public emit(metric: Metric): void {
    const log = new Log({
      requestId: this.requestId,
      type: "metric",
      time: Date.now(),
      metric,
      environment: this.environment,
      service: this.service,
      colo: this.colo,
      durableObjectId: this.durableObjectId,
    })

    // colo is important to keep track of the location
    this.logger.emit(log.toString(), {
      ...metric,
      colo: this.colo,
      country: this.country,
      continent: this.continent,
    })
  }

  public setColo(colo: string): void {
    this.colo = colo
  }

  public async flush(): Promise<void> {
    return this.logger.flush()
  }

  public x(value: string): void {
    this.requestId = value
  }
}
