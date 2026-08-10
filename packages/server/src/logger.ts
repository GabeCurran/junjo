import { type LoggerOptions, type Logger as PinoLogger, pino } from "pino";

export type LogLevel = "error" | "warn" | "info" | "debug" | "silent";

export interface CreateLoggerOptions {
  level?: LogLevel;
  nodeEnv?: string;
  destination?: NodeJS.WritableStream;
}

export type Logger = PinoLogger;

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? "info";
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? "development";

  const base: LoggerOptions = {
    level,
    base: { service: "junjo-server" },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defense-in-depth: no call site logs credentials today, but if a
    // future log line ever includes a request/config object, these
    // paths are censored rather than shipped to the log sink.
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "headers.authorization",
        "*.headers.authorization",
        "apiKey",
        "*.apiKey",
        "secret",
        "*.secret",
        "passcode",
        "*.passcode",
        "token",
        "*.token",
        // Webhook endpoint URLs carry their delivery credential in the
        // path (discord / slack tokens). No call site logs a raw `url`
        // today (endpoint logging uses `endpointOrigin`), so censoring
        // `url` here is pure defense-in-depth and over-redacts nothing.
        "url",
        "*.url",
      ],
      censor: "[redacted]",
    },
  };

  if (opts.destination) {
    return pino(base, opts.destination);
  }

  if (nodeEnv === "production") {
    return pino(base);
  }

  return pino({
    ...base,
    transport: { target: "pino-pretty", options: { colorize: true } },
  });
}

// Starts silent so importing this module (e.g. for types, or `setLogger`
// in tests) never emits anything by accident; `index.ts` swaps in the
// real logger after `loadEnv()` resolves.
let activeLogger: Logger = createLogger({ level: "silent" });

export function setLogger(next: Logger): void {
  activeLogger = next;
}

export function getLogger(): Logger {
  return activeLogger;
}

type LogMethod = (obj: unknown, msg?: string, ...args: unknown[]) => void;

export interface AppLogger {
  error: LogMethod;
  warn: LogMethod;
  info: LogMethod;
  debug: LogMethod;
}

// Forwarding via the closure means `setLogger(...)` propagates to every
// prior import site without re-importing.
export const logger: AppLogger = {
  error: (obj, msg, ...args) => (activeLogger.error as LogMethod)(obj, msg, ...args),
  warn: (obj, msg, ...args) => (activeLogger.warn as LogMethod)(obj, msg, ...args),
  info: (obj, msg, ...args) => (activeLogger.info as LogMethod)(obj, msg, ...args),
  debug: (obj, msg, ...args) => (activeLogger.debug as LogMethod)(obj, msg, ...args),
};
