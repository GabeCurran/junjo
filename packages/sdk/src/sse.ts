import type { JunjoEvent } from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import {
  type ParsedSSEFrame,
  UNKNOWN_EVENT_TYPE,
  type WireJunjoEvent,
  deserializeEvent,
  parseSSEFrame,
} from "./events.js";

// Cap on an unterminated SSE frame (in UTF-16 code units, roughly 1 MiB
// of ASCII). Real Junjo events are a few KB; anything near this is a
// broken or hostile stream.
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

// Blank line ending a frame: \n\n from the server, or \r\n\r\n (and
// mixes) after a proxy normalizes line endings.
const SSE_FRAME_DELIMITER = /\r?\n\r?\n/;

/**
 * Reads SSE frames off `reader` and hands each non-comment frame to
 * `onFrame`, in order. Resolves when the server ends the body, or as
 * soon as `isClosed()` turns true (checked before every read and after
 * every frame, so no frame is delivered once the consumer has closed).
 * Rejects with the reader's own error on a transport failure, and with
 * JunjoError "stream_overflow" when an unterminated frame passes the
 * buffer cap. `onFrame` must not throw: a throw would surface here as
 * if it were a transport failure, so callers trap their own errors and
 * flip `isClosed()` instead.
 */
export async function readSSEFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  isClosed: () => boolean,
  onFrame: (frame: ParsedSSEFrame) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!isClosed()) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) buffer += decoder.decode(value, { stream: true });
    // A server (or middlebox) that never sends the frame delimiter
    // would otherwise grow the buffer without bound.
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      throw new JunjoError(
        `SSE frame exceeded ${MAX_SSE_BUFFER_CHARS} characters without a delimiter`,
        "stream_overflow",
      );
    }
    let match = buffer.match(SSE_FRAME_DELIMITER);
    while (match?.index !== undefined) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const frame = parseSSEFrame(block);
      if (frame !== null) onFrame(frame);
      if (isClosed()) return;
      match = buffer.match(SSE_FRAME_DELIMITER);
    }
  }
}

/**
 * Decodes one frame's `data` into an event. Returns null for an event
 * type this SDK predates, so a newer server cannot kill an older
 * client's stream; throws on malformed JSON or wire data.
 */
export function decodeEventData(data: string): JunjoEvent | null {
  try {
    return deserializeEvent(JSON.parse(data) as WireJunjoEvent);
  } catch (err) {
    if (err instanceof JunjoError && err.code === UNKNOWN_EVENT_TYPE) return null;
    throw err;
  }
}

/** Normalizes an unknown thrown value into an Error. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
