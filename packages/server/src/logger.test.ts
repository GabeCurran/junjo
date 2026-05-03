import { Writable } from "node:stream";
import type { Logger as PinoLogger } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, getLogger, logger, setLogger } from "./logger";

interface CapturingDestination extends Writable {
  lines(): Array<Record<string, unknown>>;
  raw(): string;
}

function makeDestination(): CapturingDestination {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  }) as CapturingDestination;
  stream.raw = () => Buffer.concat(chunks).toString("utf8");
  stream.lines = () =>
    stream
      .raw()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return stream;
}

const ORIGINAL = getLogger();

afterEach(() => {
  setLogger(ORIGINAL);
});

describe("createLogger", () => {
  it("emits each level as JSON with service tag, msg, and ISO time", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "debug", destination: dest });
    log.error("fatal-thing");
    log.warn("warning-thing");
    log.info("informative-thing");
    log.debug("verbose-thing");

    const lines = dest.lines();
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.service).toBe("junjo-server");
      expect(typeof line.time).toBe("string");
      expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    const [errLine, warnLine, infoLine, debugLine] = lines;
    if (!errLine || !warnLine || !infoLine || !debugLine) throw new Error("missing line");
    expect(errLine.msg).toBe("fatal-thing");
    expect(errLine.level).toBe(50);
    expect(warnLine.msg).toBe("warning-thing");
    expect(warnLine.level).toBe(40);
    expect(infoLine.msg).toBe("informative-thing");
    expect(infoLine.level).toBe(30);
    expect(debugLine.msg).toBe("verbose-thing");
    expect(debugLine.level).toBe(20);
  });

  it("suppresses debug at level=info", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "info", destination: dest });
    log.debug("hidden");
    log.info("visible");
    const lines = dest.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe("visible");
  });

  it("suppresses info at level=warn", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "warn", destination: dest });
    log.info("hidden");
    log.warn("visible");
    const lines = dest.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe("visible");
  });

  it("emits nothing at level=silent", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "silent", destination: dest });
    log.error("not emitted");
    log.info("not emitted");
    expect(dest.raw()).toBe("");
  });

  it("forwards context fields from the obj overload", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "info", destination: dest });
    log.info({ port: 8787, gameId: "g1" }, "server listening");
    const [line] = dest.lines();
    expect(line).toBeDefined();
    expect(line?.msg).toBe("server listening");
    expect(line?.port).toBe(8787);
    expect(line?.gameId).toBe("g1");
  });

  it("serializes Error instances under err with type/message/stack", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "info", destination: dest });
    const boom = new Error("boom");
    log.error({ err: boom }, "delivery failed");
    const [line] = dest.lines();
    expect(line).toBeDefined();
    const err = line?.err as Record<string, unknown>;
    expect(err.type).toBe("Error");
    expect(err.message).toBe("boom");
    expect(typeof err.stack).toBe("string");
  });

  it("defaults level to info when no level is supplied", () => {
    const dest = makeDestination();
    const log = createLogger({ destination: dest });
    log.debug("hidden");
    log.info("visible");
    expect(dest.lines()).toHaveLength(1);
  });

  it("emits valid JSON on every line", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "info", destination: dest });
    log.info({ a: 1 }, "one");
    log.info({ b: 2 }, "two");
    log.info({ c: 3 }, "three");
    const raw = dest.raw().trimEnd();
    for (const line of raw.split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("respects an injected destination over the production transport branch", () => {
    const dest = makeDestination();
    const log = createLogger({ level: "info", nodeEnv: "production", destination: dest });
    log.info("captured");
    expect(dest.lines()).toHaveLength(1);
    expect(dest.lines()[0]?.msg).toBe("captured");
  });
});

describe("singleton + accessor", () => {
  it("setLogger replaces the active singleton", () => {
    const a = createLogger({ level: "info", destination: makeDestination() });
    const b = createLogger({ level: "info", destination: makeDestination() });
    setLogger(a);
    expect(getLogger()).toBe(a);
    setLogger(b);
    expect(getLogger()).toBe(b);
  });

  it("logger.info routes to the active singleton", () => {
    const dest = makeDestination();
    const next = createLogger({ level: "info", destination: dest });
    setLogger(next);
    logger.info({ k: "v" }, "hello");
    const [line] = dest.lines();
    expect(line).toBeDefined();
    expect(line?.msg).toBe("hello");
    expect(line?.k).toBe("v");
  });

  it("logger forwards every level to the active singleton", () => {
    const dest = makeDestination();
    const next = createLogger({ level: "debug", destination: dest });
    setLogger(next);
    logger.error("e");
    logger.warn("w");
    logger.info("i");
    logger.debug("d");
    const lines = dest.lines();
    expect(lines.map((l) => l.msg)).toEqual(["e", "w", "i", "d"]);
  });

  it("replacing the singleton mid-session re-routes subsequent calls", () => {
    const first = makeDestination();
    const second = makeDestination();
    setLogger(createLogger({ level: "info", destination: first }));
    logger.info("to-first");
    setLogger(createLogger({ level: "info", destination: second }));
    logger.info("to-second");
    expect(first.lines().map((l) => l.msg)).toEqual(["to-first"]);
    expect(second.lines().map((l) => l.msg)).toEqual(["to-second"]);
  });

  it("imports a real PinoLogger as the singleton type", () => {
    const next: PinoLogger = createLogger({
      level: "info",
      destination: makeDestination(),
    });
    setLogger(next);
    expect(typeof getLogger().info).toBe("function");
    expect(typeof getLogger().error).toBe("function");
  });
});
