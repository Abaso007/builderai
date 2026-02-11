import type { ErrorSchema } from "@unprice/logs"
import type { z } from "zod"

export type LogType = "metric" | "normal" | "wide_event"

export type Fields = {
  error?: z.infer<typeof ErrorSchema> | string
  service?: string
  "service.name"?: string
  "service.environment"?: string
  "log.type"?: LogType
  [field: string]: unknown
}

export interface Logger {
  x(value: string): void
  debug(message: string, fields?: Fields): void
  emit(level: "debug" | "info" | "warn" | "error", message: string, fields?: Fields): void
  info(message: string, fields?: Fields): void
  warn(message: string, fields?: Fields): void
  error(message: string | Error, fields?: Fields): void
  flush(): Promise<void>
}
