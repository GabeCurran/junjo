// Junjo.io SDK for C++

#include "sse_parser.hpp"

#include <utility>

namespace junjo::detail {

namespace {

// Matches the TS delimiter regex /\r?\n\r?\n/ anchored at `i`:
// returns the end of the match (one past its last byte), or 0 for no
// match at this position. The optional \r positions mirror regex
// backtracking: a \r only participates when a \n directly follows.
[[nodiscard]] std::size_t match_delimiter_at(std::string_view buffer, std::size_t i) noexcept {
  std::size_t j = i;
  const std::size_t n = buffer.size();
  if (buffer[j] == '\r') {
    if (j + 1 >= n || buffer[j + 1] != '\n') return 0;
    j += 2;
  } else if (buffer[j] == '\n') {
    j += 1;
  } else {
    return 0;
  }
  if (j < n && buffer[j] == '\r' && j + 1 < n && buffer[j + 1] == '\n') return j + 2;
  if (j < n && buffer[j] == '\n') return j + 1;
  return 0;
}

// Line prefixes per the TS parser: the space after the colon is
// required (a spec-minimal "data:x" line is ignored, exactly as the
// TS SDK ignores it).
constexpr std::string_view kEventPrefix = "event: ";
constexpr std::string_view kDataPrefix = "data: ";
constexpr std::string_view kIdPrefix = "id: ";

}  // namespace

std::optional<SseFrame> parse_sse_frame(std::string_view block) {
  SseFrame frame;
  bool saw_non_comment = false;
  while (true) {
    const std::size_t newline = block.find('\n');
    std::string_view line = block.substr(0, newline);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    if (!line.empty() && line.front() != ':') {
      saw_non_comment = true;
      if (line.rfind(kEventPrefix, 0) == 0) {
        frame.event = std::string(line.substr(kEventPrefix.size()));
      } else if (line.rfind(kDataPrefix, 0) == 0) {
        std::string_view payload = line.substr(kDataPrefix.size());
        if (frame.data.has_value()) {
          frame.data->push_back('\n');
          frame.data->append(payload);
        } else {
          frame.data = std::string(payload);
        }
      } else if (line.rfind(kIdPrefix, 0) == 0) {
        frame.id = std::string(line.substr(kIdPrefix.size()));
      }
      // Other field lines (or field-less lines) count as content but
      // are otherwise ignored, matching the TS parser.
    }
    if (newline == std::string_view::npos) break;
    block.remove_prefix(newline + 1);
  }
  if (!saw_non_comment) return std::nullopt;
  return frame;
}

SseParser::FeedStatus SseParser::feed(std::string_view chunk, std::vector<SseFrame>& frames) {
  if (overflowed_) return FeedStatus::Overflow;
  buffer_.append(chunk);

  // Overflow check after append, before extraction, mirroring the TS
  // loop: one read that balloons the buffer past the cap is an error
  // even if delimiters are buried inside it.
  if (buffer_.size() > kMaxBufferBytes) {
    overflowed_ = true;
    buffer_.clear();
    buffer_.shrink_to_fit();
    return FeedStatus::Overflow;
  }

  // Extract every complete frame. A delimiter is at most 4 bytes, so
  // after a scan that found nothing a later match cannot begin more
  // than 3 bytes before the old buffer end; scan_from_ skips the
  // re-scan of a large partial frame on every feed.
  std::size_t search = scan_from_;
  while (search < buffer_.size()) {
    const std::size_t end = match_delimiter_at(buffer_, search);
    if (end == 0) {
      ++search;
      continue;
    }
    std::optional<SseFrame> frame = parse_sse_frame(std::string_view(buffer_).substr(0, search));
    if (frame.has_value()) {
      frames.push_back(std::move(*frame));
    }
    buffer_.erase(0, end);
    search = 0;
  }
  scan_from_ = buffer_.size() >= 3 ? buffer_.size() - 3 : 0;
  return FeedStatus::Ok;
}

}  // namespace junjo::detail
