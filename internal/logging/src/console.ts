import { Log, type LogSchema } from "@unprice/logs"
import type { Fields, Logger } from "./interface"

export class ConsoleLogger implements Logger {
  private requestId: string
  private readonly defaultFields?: Fields

  private readonly environment: LogSchema["environment"]
  private readonly service: LogSchema["service"]

  constructor(opts: {
    requestId: string
    environment: LogSchema["environment"]
    service: LogSchema["service"]
    defaultFields?: Fields
  }) {
    this.requestId = opts.requestId
    this.environment = opts.environment
    this.service = opts.service
    this.defaultFields = opts?.defaultFields ?? {}
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

  public debug(message: string, fields?: Fields): void {
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    console.debug(
      coloredOutput ? "\x1b[32m%s\x1b[0m" : "%s",
      "debug",
      "-",
      this.marshal("debug", message, fields)
    )
  }

  public emit(message: string, fields?: Fields): void {
    console.info(this.marshal("debug", message, fields))
  }

  public info(message: string, fields?: Fields): void {
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    console.info(
      coloredOutput ? "\x1b[36m%s\x1b[0m" : "%s",
      "info",
      "-",
      this.marshal("info", message, fields)
    )
  }
  public warn(message: string, fields?: Fields): void {
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    console.warn(
      coloredOutput ? "\x1b[33m%s\x1b[0m" : "%s",
      "warn",
      "-",
      this.marshal("warn", message, fields)
    )
  }
  public error(message: string, fields?: Fields): void {
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    console.error(
      coloredOutput ? "\x1b[31m%s\x1b[0m" : "%s",
      "error",
      "-",
      this.marshal("error", message, fields)
    )
  }
  public fatal(message: string, fields?: Fields): void {
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    console.error(
      coloredOutput ? "\x1b[31m%s\x1b[0m" : "%s",
      "fatal",
      "-",
      this.marshal("fatal", message, fields)
    )
  }

  public async flush(): Promise<void> {
    return Promise.resolve()
  }

  public setRequestId(requestId: string): void {
    this.requestId = requestId
  }
}
