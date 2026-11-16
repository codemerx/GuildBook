// Structured logs per process, rotating, with secrets redacted (IMPLEMENTATION.md §2.12).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds these fields to every line, e.g. the instance or the correlation id. */
  child(fields: LogFields): Logger;
}
