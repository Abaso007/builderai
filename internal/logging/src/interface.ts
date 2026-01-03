export type Fields = {
  error?: unknown
  service?: string
  [field: string]: unknown
}

export interface Logger {
  x(value: string): void
  debug(message: string, fields?: Fields): void
  emit(message: string, fields?: Fields): void
  info(message: string, fields?: Fields): void
  warn(message: string, fields?: Fields): void
  error(message: string, fields?: Fields): void
  flush(): Promise<void>
}
