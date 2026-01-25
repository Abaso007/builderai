import { Axiom } from "@axiomhq/js"
import { AxiomJSTransport, Logger as LoggerAxiom } from "@axiomhq/logging"
import { Log, type LogSchema } from "@unprice/logs"
import type { Fields, Logger } from "./interface"

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
    }).with({
      ...this.defaultFields,
    })
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
      context: { ...this.defaultFields, ...fields },
      environment: this.environment,
      service: this.service,
    }).toString()
  }

  public log(level: typeof this.logLevel, message: string, fields?: Fields): void {
    if (level === "off") return
    this.client[level](this.marshal(level, message, fields), {
      ...fields,
    })
  }

  public emit(message: string, fields?: Fields): void {
    if (this.logLevel === "off") return
    this.client.info(this.marshal("info", message, fields), {
      ...fields,
    })
  }
  public debug(message: string, fields?: Fields): void {
    if (this.logLevel !== "debug") return
    this.client.debug(this.marshal("debug", message, fields), {
      ...fields,
    })
  }
  public info(message: string, fields?: Fields): void {
    if (!["debug", "info"].includes(this.logLevel)) return
    this.client.info(this.marshal("info", message, fields), {
      ...fields,
    })
  }
  public warn(message: string, fields?: Fields): void {
    if (!["debug", "info", "warn"].includes(this.logLevel)) return
    this.client.warn(this.marshal("warn", message, fields), {
      ...fields,
    })
  }
  public error(message: string, fields?: Fields): void {
    if (this.logLevel === "off") return
    this.client.error(this.marshal("error", message, fields), {
      ...fields,
    })
  }
  public fatal(message: string, fields?: Fields): void {
    if (this.logLevel === "off") return
    this.client.error(this.marshal("fatal", message, fields), {
      ...fields,
    })
  }

  public async flush(): Promise<void> {
    await this.client.flush()
  }

  public x(requestId: string): void {
    this.requestId = requestId
  }
}
