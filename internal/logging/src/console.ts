import { Log, type LogSchema } from "@unprice/logs"
import type { Fields, Logger } from "./interface"

export class ConsoleLogger implements Logger {
  private requestId: string
  private readonly defaultFields?: Fields
  private readonly environment: LogSchema["environment"]
  private readonly service: LogSchema["service"]
  private readonly logLevel: "debug" | "error" | "info" | "off" | "warn"
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly console: (...args: any[]) => void

  constructor(opts: {
    requestId: string
    environment: LogSchema["environment"]
    service: LogSchema["service"]
    defaultFields?: Fields
    // The hierarchy should be: debug < info < warn < error < fatal
    logLevel?: "debug" | "error" | "info" | "off" | "warn"
  }) {
    this.requestId = opts.requestId
    this.environment = opts.environment
    this.service = opts.service
    this.defaultFields = opts?.defaultFields ?? {}
    this.logLevel = opts.logLevel ?? "info"
    this.console = opts.logLevel === "off" ? () => {} : console.log
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
    if (this.logLevel !== "debug") return
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    this.console(
      coloredOutput ? "\x1b[32m%s\x1b[0m" : "",
      "debug",
      "-",
      this.marshal("debug", message, fields)
    )
  }

  public emit(message: string, fields?: Fields): void {
    this.console(this.marshal("debug", message, fields))
  }

  public info(message: string, fields?: Fields): void {
    if (!["debug", "info"].includes(this.logLevel)) return
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    this.console(
      coloredOutput ? "\x1b[36m%s\x1b[0m" : "",
      "info",
      "-",
      this.marshal("info", message, fields)
    )
  }

  public warn(message: string, fields?: Fields): void {
    if (!["debug", "info", "warn"].includes(this.logLevel)) return
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    this.console(
      coloredOutput ? "\x1b[33m%s\x1b[0m" : "",
      "warn",
      "-",
      this.marshal("warn", message, fields)
    )
  }

  public error(message: string, fields?: Fields): void {
    // errors should be shown for all levels except "off"
    if (this.logLevel === "off") return
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    this.console(
      coloredOutput ? "\x1b[31m%s\x1b[0m" : "",
      "error",
      "-",
      this.marshal("error", message, fields)
    )
  }

  public fatal(message: string, fields?: Fields): void {
    // fatal errors should be shown for all levels except "off"
    if (this.logLevel === "off") return
    // don't show colored output in production mode because it's not readable
    const coloredOutput = this.environment !== "production"
    this.console(
      coloredOutput ? "\x1b[31m%s\x1b[0m" : "",
      "fatal",
      "-",
      this.marshal("fatal", message, fields)
    )
  }

  public async flush(): Promise<void> {
    return Promise.resolve()
  }

  public x(requestId: string): void {
    this.requestId = requestId
  }
}
