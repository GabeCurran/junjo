// Junjo.io SDK for C++

#include "hmac_sha256.hpp"

#include <cstring>

namespace junjo::detail {

namespace {

// FIPS 180-4 section 4.2.2: the first 32 bits of the fractional parts
// of the cube roots of the first 64 primes.
constexpr std::uint32_t kRoundConstants[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u,
    0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu,
    0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu,
    0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
    0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u,
    0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u,
    0xc67178f2u,
};

[[nodiscard]] constexpr std::uint32_t rotr(std::uint32_t value, int by) noexcept {
  return (value >> by) | (value << (32 - by));
}

// Incremental SHA-256 over 64-byte blocks.
class Sha256 {
 public:
  void update(const std::uint8_t* data, std::size_t size) {
    total_bytes_ += size;
    while (size > 0) {
      const std::size_t space = 64 - buffered_;
      const std::size_t take = size < space ? size : space;
      std::memcpy(buffer_ + buffered_, data, take);
      buffered_ += take;
      data += take;
      size -= take;
      if (buffered_ == 64) {
        compress(buffer_);
        buffered_ = 0;
      }
    }
  }

  [[nodiscard]] std::array<std::uint8_t, 32> finish() {
    // Padding: 0x80, zeros to 56 mod 64, then the bit length as a
    // 64-bit big-endian integer.
    const std::uint64_t bit_length = total_bytes_ * 8;
    const std::uint8_t one = 0x80;
    update(&one, 1);
    const std::uint8_t zero = 0x00;
    while (buffered_ != 56) {
      update(&zero, 1);
    }
    std::uint8_t length_bytes[8];
    for (int i = 0; i < 8; ++i) {
      length_bytes[i] = static_cast<std::uint8_t>(bit_length >> (56 - 8 * i));
    }
    // Bypass update() for the length so total_bytes_ (already captured)
    // is not disturbed; the buffer has exactly 8 bytes of space.
    std::memcpy(buffer_ + buffered_, length_bytes, 8);
    compress(buffer_);

    std::array<std::uint8_t, 32> digest{};
    for (int i = 0; i < 8; ++i) {
      digest[static_cast<std::size_t>(4 * i)] = static_cast<std::uint8_t>(state_[i] >> 24);
      digest[static_cast<std::size_t>(4 * i + 1)] = static_cast<std::uint8_t>(state_[i] >> 16);
      digest[static_cast<std::size_t>(4 * i + 2)] = static_cast<std::uint8_t>(state_[i] >> 8);
      digest[static_cast<std::size_t>(4 * i + 3)] = static_cast<std::uint8_t>(state_[i]);
    }
    return digest;
  }

 private:
  void compress(const std::uint8_t* block) {
    std::uint32_t schedule[64];
    for (int t = 0; t < 16; ++t) {
      schedule[t] = (static_cast<std::uint32_t>(block[4 * t]) << 24) |
                    (static_cast<std::uint32_t>(block[4 * t + 1]) << 16) |
                    (static_cast<std::uint32_t>(block[4 * t + 2]) << 8) |
                    static_cast<std::uint32_t>(block[4 * t + 3]);
    }
    for (int t = 16; t < 64; ++t) {
      const std::uint32_t s0 =
          rotr(schedule[t - 15], 7) ^ rotr(schedule[t - 15], 18) ^ (schedule[t - 15] >> 3);
      const std::uint32_t s1 =
          rotr(schedule[t - 2], 17) ^ rotr(schedule[t - 2], 19) ^ (schedule[t - 2] >> 10);
      schedule[t] = schedule[t - 16] + s0 + schedule[t - 7] + s1;
    }

    std::uint32_t a = state_[0];
    std::uint32_t b = state_[1];
    std::uint32_t c = state_[2];
    std::uint32_t d = state_[3];
    std::uint32_t e = state_[4];
    std::uint32_t f = state_[5];
    std::uint32_t g = state_[6];
    std::uint32_t h = state_[7];

    for (int t = 0; t < 64; ++t) {
      const std::uint32_t big_s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const std::uint32_t choose = (e & f) ^ (~e & g);
      const std::uint32_t temp1 = h + big_s1 + choose + kRoundConstants[t] + schedule[t];
      const std::uint32_t big_s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const std::uint32_t temp2 = big_s0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }

    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  // FIPS 180-4 section 5.3.3 initial hash value.
  std::uint32_t state_[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                             0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  std::uint8_t buffer_[64] = {};
  std::size_t buffered_ = 0;
  std::uint64_t total_bytes_ = 0;
};

}  // namespace

std::array<std::uint8_t, 32> sha256(const std::uint8_t* data, std::size_t size) {
  Sha256 hasher;
  hasher.update(data, size);
  return hasher.finish();
}

std::array<std::uint8_t, 32> hmac_sha256(std::string_view key, std::string_view message) {
  constexpr std::size_t kBlockSize = 64;

  // RFC 2104: a key longer than the block is hashed down first, then
  // zero-padded to the block size.
  std::uint8_t padded_key[kBlockSize] = {};
  if (key.size() > kBlockSize) {
    const std::array<std::uint8_t, 32> hashed =
        sha256(reinterpret_cast<const std::uint8_t*>(key.data()), key.size());
    std::memcpy(padded_key, hashed.data(), hashed.size());
  } else if (!key.empty()) {
    std::memcpy(padded_key, key.data(), key.size());
  }

  std::uint8_t inner_pad[kBlockSize];
  std::uint8_t outer_pad[kBlockSize];
  for (std::size_t i = 0; i < kBlockSize; ++i) {
    inner_pad[i] = static_cast<std::uint8_t>(padded_key[i] ^ 0x36u);
    outer_pad[i] = static_cast<std::uint8_t>(padded_key[i] ^ 0x5cu);
  }

  Sha256 inner;
  inner.update(inner_pad, kBlockSize);
  inner.update(reinterpret_cast<const std::uint8_t*>(message.data()), message.size());
  const std::array<std::uint8_t, 32> inner_digest = inner.finish();

  Sha256 outer;
  outer.update(outer_pad, kBlockSize);
  outer.update(inner_digest.data(), inner_digest.size());
  return outer.finish();
}

std::string to_hex(const std::uint8_t* bytes, std::size_t size) {
  constexpr char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (std::size_t i = 0; i < size; ++i) {
    out.push_back(kDigits[bytes[i] >> 4]);
    out.push_back(kDigits[bytes[i] & 0x0f]);
  }
  return out;
}

bool constant_time_equal(std::string_view a, std::string_view b) noexcept {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    diff = static_cast<unsigned char>(
        diff | (static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i])));
  }
  return diff == 0;
}

}  // namespace junjo::detail
