import { Axiom } from "@axiomhq/js"
import { AxiomJSTransport, EVENT, Logger as LoggerAxiom } from "@axiomhq/logging"
import { Log, type LogSchema } from "@unprice/logs"
import type { Fields, LogType, Logger } from "./interface"

export class AxiomLogger implements Logger {
  private requestId: string
  private readonly client: LoggerAxiom
  private readonly defaultFields?: Fields
  private readonly environment: LogSchema["environment"]
  private readonly service: LogSchema["service"]
  private readonly logLevel: "debug" | "error" | "info" | "off" | "warn"

  constructor(opts: {
    requestId: string
    defaultFields?: Fields
    apiKey: string
    dataset: string
    environment: LogSchema["environment"]
    service: LogSchema["service"]
    logLevel?: "debug" | "error" | "info" | "off" | "warn"
  }) {
    this.requestId = opts.requestId
    this.defaultFields = {
      ...opts?.defaultFields,
      service: opts.service,
      environment: opts.environment,
      "service.name": opts.service,
      "service.environment": opts.environment,
    }
    this.environment = opts.environment
    this.service = opts.service
    this.logLevel = opts.logLevel ?? "info"

    this.client = new LoggerAxiom({
      transports: [
        // new ConsoleTransport({
        //   prettyPrint: true,
        //   logLevel: this.logLevel === "off" ? undefined : this.logLevel,
        // }),
        new AxiomJSTransport({
          axiom: new Axiom({
            token: opts.apiKey,
          }),
          dataset: opts.dataset,
        }),
      ],
    })
  }

  private withMetadata(fields?: Fields, defaultLogType: LogType = "normal"): Fields {
    const enriched: Fields = {
      ...this.defaultFields,
      ...fields,
    }

    if (!enriched["service.name"]) {
      enriched["service.name"] = this.service
    }
    if (!enriched["service.environment"]) {
      enriched["service.environment"] = this.environment
    }
    if (!enriched.service) {
      enriched.service = this.service
    }
    if (!enriched.environment) {
      enriched.environment = this.environment
    }
    if (!enriched["log.type"]) {
      enriched["log.type"] = defaultLogType
    }

    return enriched
  }

  /**
   * Emit only canonical metadata fields for plain text log lines so we keep
   * Axiom columns stable for ad-hoc logs.
   */
  private toMetadataTransportArgs(
    fields?: Fields,
    defaultLogType: LogType = "normal"
  ): Record<string | symbol, unknown> {
    const metadata = this.withMetadata(fields, defaultLogType)
    const event: Fields = {}

    if (metadata["service.name"] !== undefined) {
      event["service.name"] = metadata["service.name"]
    }
    if (metadata["service.environment"] !== undefined) {
      event["service.environment"] = metadata["service.environment"]
    }
    if (metadata["log.type"] !== undefined) {
      event["log.type"] = metadata["log.type"]
    }

    return {
      [EVENT]: event,
    }
  }

  /**
   * Emit full structured payload for wide events and metrics.
   */
  private toStructuredTransportArgs(
    fields?: Fields,
    defaultLogType: LogType = "normal"
  ): Record<string | symbol, unknown> {
    return {
      [EVENT]: this.withMetadata(fields, defaultLogType),
    }
  }

  private marshal(
    level: "debug" | "info" | "warn" | "error" | "fatal",
    message: string,
    fields?: Fields
  ): string {
    return new Log({
      type: "log",
      requestId: this.requestId,
      time: Date.now(),
      level,
      message,
      context: this.withMetadata(fields),
      environment: this.environment,
      service: this.service,
    }).toString()
  }

  public emit(level: "debug" | "info" | "warn" | "error", message: string, fields?: Fields): void {
    if (this.logLevel === "off") return
    this.client[level](message, this.toStructuredTransportArgs(fields))
  }

  public debug(message: string, fields?: Fields): void {
    if (this.logLevel !== "debug") return
    this.client.debug(this.marshal("debug", message, fields), this.toMetadataTransportArgs(fields))
  }

  public info(message: string, fields?: Fields): void {
    if (!["debug", "info"].includes(this.logLevel)) return
    this.client.info(this.marshal("info", message, fields), this.toMetadataTransportArgs(fields))
  }
  public warn(message: string, fields?: Fields): void {
    if (!["debug", "info", "warn"].includes(this.logLevel)) return
    this.client.warn(this.marshal("warn", message, fields), this.toMetadataTransportArgs(fields))
  }
  public error(message: string, fields?: Fields): void {
    if (this.logLevel === "off") return
    this.client.error(this.marshal("error", message, fields), this.toMetadataTransportArgs(fields))
  }
  public fatal(message: string, fields?: Fields): void {
    if (this.logLevel === "off") return
    this.client.error(this.marshal("fatal", message, fields), this.toMetadataTransportArgs(fields))
  }

  public async flush(): Promise<void> {
    await this.client.flush()
  }

  public x(requestId: string): void {
    this.requestId = requestId
  }
}
