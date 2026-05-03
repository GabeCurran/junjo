import { type LoggerOptions, type Logger as PinoLogger, pino } from "pino";

// Structured logger (Phase 14.2). Production (NODE_ENV=production with
// no caller-supplied destination) emits one JSON object per line on
// stdout, parseable by Datadog / Loki / CloudWatch / ELK out of the box.
// Dev / test: pretty-printed via `pino-pretty` (level prefix + indented
// payloads) for human readability. Tests: pass a `Writable` `destination`
// to capture raw JSON-line bytes; the pretty transport is bypassed.

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

// Module-level singleton starts at `silent` so importing this module
// for types (or for `setLogger` in tests) never emits anything by
// accident. The server entry point installs the real logger via
// `setLogger(createLogger({ level, nodeEnv }))` after `loadEnv()` resolves.
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

// Variadic forwarding to the active singleton means `setLogger(...)`
// propagates to every prior import site without re-importing.
export const logger: AppLogger = {
  error: (obj, msg, ...args) => (activeLogger.error as LogMethod)(obj, msg, ...args),
  warn: (obj, msg, ...args) => (activeLogger.warn as LogMethod)(obj, msg, ...args),
  info: (obj, msg, ...args) => (activeLogger.info as LogMethod)(obj, msg, ...args),
  debug: (obj, msg, ...args) => (activeLogger.debug as LogMethod)(obj, msg, ...args),
};
