// Structured logs per process (IMPLEMENTATION.md §2.12, ADR 0020): one JSON object per line, rotating, through
// electron-log's Node transport, with secrets redacted and the time taken from the Clock port.
import type { Clock, LogFields, Logger, LogLevel } from '@app/core';
import electronLog from 'electron-log/node';
import { redact } from './redact.ts';

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface FileLoggerOptions {
  /** The log file, e.g. <data folder>/logs/main.log. */
  readonly file: string;
  readonly clock: Clock;
  readonly level?: LogLevel;
  /** Rotation size; electron-log keeps one previous file next to it. */
  readonly maxBytes?: number;
  /** Also write to stderr, e.g. in development. */
  readonly echo?: boolean;
  readonly fields?: LogFields;
}

type Sink = (level: LogLevel, line: string) => void;

class StructuredLogger implements Logger {
  readonly #sink: Sink;
  readonly #clock: Clock;
  readonly #level: LogLevel;
  readonly #fields: LogFields;

  constructor(sink: Sink, clock: Clock, level: LogLevel, fields: LogFields) {
    this.#sink = sink;
    this.#clock = clock;
    this.#level = level;
    this.#fields = fields;
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (order[level] < order[this.#level]) return;
    try {
      const line = JSON.stringify({
        time: new Date(this.#clock.now()).toISOString(),
        level,
        message: redact(message),
        ...(redact({ ...this.#fields, ...fields }) as Record<string, unknown>),
      });
      this.#sink(level, line);
    } catch {
      // Logging never breaks the caller.
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields);
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(this.#sink, this.#clock, this.#level, { ...this.#fields, ...fields });
  }
}

let nextLogId = 0;

export function createFileLogger(options: FileLoggerOptions): Logger {
  const instance = electronLog.create({ logId: `app-${nextLogId++}` });
  instance.transports.file.resolvePathFn = () => options.file;
  instance.transports.file.format = '{text}';
  instance.transports.file.maxSize = options.maxBytes ?? 5 * 1024 * 1024;
  instance.transports.file.level = 'silly';
  instance.transports.console.level = options.echo ? 'silly' : false;
  instance.transports.console.format = '{text}';
  instance.errorHandler.stopCatching();
  const sink: Sink = (level, line) => instance[level](line);
  return new StructuredLogger(sink, options.clock, options.level ?? 'info', options.fields ?? {});
}

/** A logger that writes through a function, e.g. into a test's memory or a pending worker's device-level log. */
export function createLineLogger(write: (line: string) => void, clock: Clock, level: LogLevel = 'debug'): Logger {
  return new StructuredLogger((_level, line) => write(line), clock, level, {});
}
