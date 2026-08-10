// Junjo.io SDK for C++: incremental SSE parser. Pure state-machine
// tests: no threads, no transport, chunk boundaries chosen by the
// test. Includes internal headers from src/ on purpose.
#include <doctest/doctest.h>

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include "sse_parser.hpp"

using junjo::detail::parse_sse_frame;
using junjo::detail::SseFrame;
using junjo::detail::SseParser;

namespace {

// Feeds `input` in pieces of `chunk_size` bytes and returns every
// completed frame. Fails the test on overflow.
[[nodiscard]] std::vector<SseFrame> feed_in_chunks(std::string_view input,
                                                   std::size_t chunk_size) {
  SseParser parser;
  std::vector<SseFrame> frames;
  for (std::size_t i = 0; i < input.size(); i += chunk_size) {
    const std::string_view chunk = input.substr(i, chunk_size);
    REQUIRE(parser.feed(chunk, frames) == SseParser::FeedStatus::Ok);
  }
  return frames;
}

constexpr std::string_view kThreeFrames =
    "event: member.joined\n"
    "id: evt_1\n"
    "data: {\"type\":\"member.joined\",\"n\":1}\n"
    "\n"
    ":heartbeat\n"
    "\n"
    "event: member.left\r\n"
    "id: evt_2\r\n"
    "data: {\"type\":\"member.left\",\"n\":2}\r\n"
    "\r\n"
    "data: {\"n\":3}\n"
    "\n";

void check_three_frames(const std::vector<SseFrame>& frames) {
  REQUIRE(frames.size() == 3);
  CHECK(frames[0].event == "member.joined");
  CHECK(frames[0].id == "evt_1");
  CHECK(frames[0].data == R"({"type":"member.joined","n":1})");
  CHECK(frames[1].event == "member.left");
  CHECK(frames[1].id == "evt_2");
  CHECK(frames[1].data == R"({"type":"member.left","n":2})");
  CHECK_FALSE(frames[2].event.has_value());
  CHECK_FALSE(frames[2].id.has_value());
  CHECK(frames[2].data == R"({"n":3})");
}

}  // namespace

TEST_CASE("a complete frame parses event, id, and data") {
  SseParser parser;
  std::vector<SseFrame> frames;
  REQUIRE(parser.feed("event: member.joined\nid: evt_1\ndata: {\"a\":1}\n\n", frames) ==
          SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK(frames[0].event == "member.joined");
  CHECK(frames[0].id == "evt_1");
  CHECK(frames[0].data == R"({"a":1})");
}

TEST_CASE("byte-by-byte delivery yields the same frames as one chunk") {
  // The heart of incremental parsing: every chunk boundary, including
  // boundaries inside the delimiter, inside a CRLF pair, and inside
  // field prefixes, must be invisible.
  check_three_frames(feed_in_chunks(kThreeFrames, kThreeFrames.size()));
  check_three_frames(feed_in_chunks(kThreeFrames, 1));
}

TEST_CASE("every chunk size yields the same frames") {
  for (std::size_t chunk_size = 2; chunk_size <= 17; ++chunk_size) {
    check_three_frames(feed_in_chunks(kThreeFrames, chunk_size));
  }
}

TEST_CASE("all four delimiter line-ending mixes terminate a frame") {
  for (const std::string_view delimiter : {"\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n"}) {
    SseParser parser;
    std::vector<SseFrame> frames;
    std::string input = "data: x";
    input += delimiter;
    REQUIRE(parser.feed(input, frames) == SseParser::FeedStatus::Ok);
    REQUIRE(frames.size() == 1);
    CHECK(frames[0].data == "x");
  }
}

TEST_CASE("a lone carriage return is not a line ending") {
  SseParser parser;
  std::vector<SseFrame> frames;
  // \r without \n stays inside the data payload's line; no frame ends.
  REQUIRE(parser.feed("data: a\rb", frames) == SseParser::FeedStatus::Ok);
  CHECK(frames.empty());
  REQUIRE(parser.feed("\n\n", frames) == SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK(frames[0].data == "a\rb");
}

TEST_CASE("comment-only frames are dropped entirely") {
  SseParser parser;
  std::vector<SseFrame> frames;
  REQUIRE(parser.feed(":heartbeat\n\n:another\r\n\r\n", frames) == SseParser::FeedStatus::Ok);
  CHECK(frames.empty());
}

TEST_CASE("comment lines inside a real frame are ignored") {
  SseParser parser;
  std::vector<SseFrame> frames;
  REQUIRE(parser.feed(":keepalive\ndata: x\n:trailing\n\n", frames) ==
          SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK(frames[0].data == "x");
}

TEST_CASE("multi-line data joins with a newline") {
  SseParser parser;
  std::vector<SseFrame> frames;
  REQUIRE(parser.feed("data: line one\ndata: line two\n\n", frames) ==
          SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK(frames[0].data == "line one\nline two");
}

TEST_CASE("unknown field lines are ignored but still make the frame non-empty") {
  SseParser parser;
  std::vector<SseFrame> frames;
  REQUIRE(parser.feed("retry: 3000\ndata: x\n\n", frames) == SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK(frames[0].data == "x");

  // A frame of only unknown fields is emitted (with no data); the
  // subscription layer skips frames without data.
  frames.clear();
  REQUIRE(parser.feed("retry: 3000\n\n", frames) == SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK_FALSE(frames[0].data.has_value());
}

TEST_CASE("field prefixes require the space after the colon, matching the TS parser") {
  SseParser parser;
  std::vector<SseFrame> frames;
  REQUIRE(parser.feed("data:x\nevent:y\nid:z\n\n", frames) == SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK_FALSE(frames[0].data.has_value());
  CHECK_FALSE(frames[0].event.has_value());
  CHECK_FALSE(frames[0].id.has_value());
}

TEST_CASE("the overflow boundary is exact") {
  const std::string almost(SseParser::kMaxBufferBytes, 'a');

  SseParser at_cap;
  std::vector<SseFrame> frames;
  // Exactly the cap, unterminated: still fine (the TS check is
  // strictly greater-than).
  REQUIRE(at_cap.feed(almost, frames) == SseParser::FeedStatus::Ok);

  SseParser past_cap;
  REQUIRE(past_cap.feed(almost, frames) == SseParser::FeedStatus::Ok);
  CHECK(past_cap.feed("b", frames) == SseParser::FeedStatus::Overflow);
  // Poisoned: further feeds keep reporting overflow.
  CHECK(past_cap.feed("\n\n", frames) == SseParser::FeedStatus::Overflow);
  CHECK(frames.empty());
}

TEST_CASE("one oversized chunk overflows even when it contains delimiters") {
  // TS parity: the cap check runs after append and before extraction,
  // so a single read that balloons the buffer fails even though
  // complete frames are buried inside it.
  std::string input;
  input.reserve(SseParser::kMaxBufferBytes + 32);
  input += "data: x\n\n";
  input.append(SseParser::kMaxBufferBytes, 'a');
  SseParser parser;
  std::vector<SseFrame> frames;
  CHECK(parser.feed(input, frames) == SseParser::FeedStatus::Overflow);
  CHECK(frames.empty());
}

TEST_CASE("frames drained before the cap keep a long stream under it") {
  // Many small frames fed one at a time never accumulate.
  SseParser parser;
  std::vector<SseFrame> frames;
  const std::string frame = "data: payload\n\n";
  const std::size_t count = (SseParser::kMaxBufferBytes / frame.size()) + 16;
  for (std::size_t i = 0; i < count; ++i) {
    REQUIRE(parser.feed(frame, frames) == SseParser::FeedStatus::Ok);
  }
  CHECK(frames.size() == count);
}

TEST_CASE("a partial frame is retained across feeds") {
  SseParser parser;
  std::vector<SseFrame> frames;
  REQUIRE(parser.feed("data: he", frames) == SseParser::FeedStatus::Ok);
  CHECK(frames.empty());
  REQUIRE(parser.feed("llo\n", frames) == SseParser::FeedStatus::Ok);
  CHECK(frames.empty());
  REQUIRE(parser.feed("\n", frames) == SseParser::FeedStatus::Ok);
  REQUIRE(frames.size() == 1);
  CHECK(frames[0].data == "hello");
}

TEST_CASE("parse_sse_frame returns nullopt only for comment-and-blank blocks") {
  CHECK_FALSE(parse_sse_frame(":heartbeat").has_value());
  CHECK_FALSE(parse_sse_frame("").has_value());
  CHECK_FALSE(parse_sse_frame(":a\n:b").has_value());
  CHECK(parse_sse_frame("weird line").has_value());
}
