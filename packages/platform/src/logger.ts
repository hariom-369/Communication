import pino, { type DestinationStream } from 'pino';

/**
 * Allow-listed structured log fields (ADR-026, docs/observability.md §4).
 *
 * Anything not listed here is dropped before it reaches the log pipeline. Values must be
 * primitives, so request bodies, headers or other objects can never be logged by accident.
 * Adding a field requires review: it must not be able to carry message content, credentials,
 * tokens, keys or other sensitive user content.
 */
export const LOG_FIELDS = [
  'attempt',
  'check',
  'component',
  'count',
  'deviceId',
  'durationMs',
  'errorCode',
  'errorId',
  'errorMessage',
  'errorName',
  'limitName',
  'method',
  'migration',
  'ok',
  'port',
  'reqId',
  'routeId',
  'signal',
  'sizeBytes',
  'stack',
  'statusCode',
  'userId',
  'version',
] as const;

export type LogField = (typeof LOG_FIELDS)[number];
export type LogValue = string | number | boolean | null;
export type LogFields = Partial<Record<LogField, LogValue>>;

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Logger {
  fatal(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  /** Serialises an error into allow-listed fields according to the logger's detail policy. */
  errorFields(error: unknown): LogFields;
}

export interface LoggerOptions {
  service: string;
  level: LogLevel;
  /**
   * Include error messages and stacks of *unexpected* errors. Messages from third-party errors may
   * contain user data, so this is off in production by default (docs/observability.md §4).
   */
  errorDetails: boolean;
  /** Output stream; defaults to stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
}

const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const MAX_STRING_LENGTH = 512;
const ALLOWED = new Set<string>(LOG_FIELDS);

/** Errors whose messages are written by us and known not to contain user data. */
export interface SafeMessageError {
  readonly safeToLog: true;
  readonly message: string;
  readonly code?: string;
}

function isSafeMessageError(error: unknown): error is SafeMessageError & Error {
  return error instanceof Error && (error as Partial<SafeMessageError>).safeToLog === true;
}

export function sanitizeFields(fields: Readonly<Record<string, unknown>>): LogFields {
  const out: Record<string, LogValue> = {};
  // LogFields is a partial record of allow-listed keys; `ALLOWED.has` enforces that below.
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    }
    // Objects, arrays, functions, bigint, symbols and undefined are dropped.
  }
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const base = pino(
    {
      level: options.level,
      base: { service: options.service },
      messageKey: 'event',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination,
  );
  return wrap(base, options.errorDetails);
}

function wrap(instance: pino.Logger, errorDetails: boolean): Logger {
  const emit =
    (level: 'fatal' | 'error' | 'warn' | 'info' | 'debug') =>
    (event: string, fields: LogFields = {}): void => {
      const safeEvent = EVENT_NAME.test(event) ? event : 'invalid_event_name';
      instance[level](sanitizeFields(fields), safeEvent);
    };

  return {
    fatal: emit('fatal'),
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (bindings) => wrap(instance.child(sanitizeFields(bindings)), errorDetails),
    errorFields: (error) => {
      if (!(error instanceof Error)) return { errorName: typeof error };
      const code = (error as { code?: unknown }).code;
      const fields: LogFields = { errorName: error.name };
      if (typeof code === 'string') fields.errorCode = code;
      if (isSafeMessageError(error) || errorDetails) fields.errorMessage = error.message;
      if (errorDetails && error.stack !== undefined) fields.stack = error.stack;
      return sanitizeFields(fields);
    },
  };
}
