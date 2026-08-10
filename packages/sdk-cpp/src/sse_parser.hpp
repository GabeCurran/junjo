// Junjo.io SDK for C++
//
// Incremental SSE frame parser: bytes in, frames out. Pure state
// machine over a growing buffer; no threads, no transport, no I/O, so
// the tests can drive it with arbitrary chunk boundaries. The framing
// and field rules mirror the TS SDK exactly (packages/sdk/src/groups.ts
// subscribe loop + packages/sdk/src/events.ts parseSSEFrame):
//   - a frame ends at a blank line: \n\n from the server, or
//     \r\n\r\n and mixes after a proxy normalizes line endings;
//   - within a frame, "event: " / "id: " / "data: " lines are read
//     (space after the colon required, as in the TS SDK), multi-line
//     data joins with '\n', one trailing \r per line is stripped;
//   - comment lines (leading ':', the server's 30s heartbeats) and
//     unknown field lines are ignored; a frame containing nothing
//     else is dropped entirely;
//   - an unterminated buffer larger than kMaxBufferBytes is an
//     overflow (broken or hostile stream). Checked after append and
//     before extraction, exactly like the TS loop, so one oversized
//     read overflows even if it contains delimiters. The TS cap is
//     the same number in UTF-16 code units; identical for the ASCII
//     framing bytes that dominate real streams.
// Not installed.
#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace junjo::detail {

// One parsed SSE frame. Fields absent from the frame stay nullopt;
// the subscription layer only dispatches frames with data present
// (TS parity: frames without data are skipped).
struct SseFrame {
  std::optional<std::string> event;
  std::optional<std::string> id;
  std::optional<std::string> data;
};

class SseParser {
 public:
  // Cap on an unterminated frame. Real Junjo events are a few KB.
  static constexpr std::size_t kMaxBufferBytes = 1024 * 1024;

  enum class FeedStatus {
    Ok,
    // The buffer exceeded kMaxBufferBytes; the stream should be torn
    // down (ErrorCode::StreamOverflow). The parser is poisoned: every
    // further feed keeps reporting Overflow.
    Overflow,
  };

  // Appends `chunk` and moves every completed frame into `frames`
  // (appended in stream order; comment-only frames are dropped, not
  // appended). Partial trailing input is retained for the next feed.
  [[nodiscard]] FeedStatus feed(std::string_view chunk, std::vector<SseFrame>& frames);

 private:
  std::string buffer_;
  // Delimiter-scan resume point: a delimiter is at most 4 bytes, so
  // after a scan that found nothing, a later match cannot begin more
  // than 3 bytes before the old buffer end. Keeps byte-at-a-time
  // feeding of a large frame linear instead of quadratic.
  std::size_t scan_from_ = 0;
  bool overflowed_ = false;
};

// Parses one delimiter-free frame block (TS parseSSEFrame). Returns
// nullopt for blocks containing only comments and blank lines.
// Exposed for direct testing; feed() is the streaming entry point.
[[nodiscard]] std::optional<SseFrame> parse_sse_frame(std::string_view block);

}  // namespace junjo::detail
