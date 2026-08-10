// Junjo.io SDK for C++: external consumer example.
//
// Constructs a junjo::Client against a base URL from argv[1] or the
// JUNJO_BASE_URL environment variable (default: a local dev server at
// http://127.0.0.1:8787), calls key_info, and prints whichever branch
// of the Result came back. With a live server and a valid JUNJO_API_KEY
// it prints the resolved game id; with no server listening it exits
// cleanly with the typed network_error, which is exactly what this
// example exists to demonstrate: API and transport failures are values,
// not exceptions.
//
// Exit codes: 0 = key_info succeeded, 2 = typed error (the expected
// outcome when no server is running), 1 = client construction failed.

#include <cstdlib>
#include <iostream>
#include <string>

#include <junjo/client.hpp>

int main(int argc, char** argv) {
  std::string base_url = "http://127.0.0.1:8787";
  if (const char* env = std::getenv("JUNJO_BASE_URL")) base_url = env;
  if (argc > 1) base_url = argv[1];

  // Any jk_-shaped key builds a client; create() never performs I/O.
  // Supply a real key via JUNJO_API_KEY to exercise the success branch
  // against a live server.
  std::string api_key = "jk_example.not-a-real-secret";
  if (const char* env = std::getenv("JUNJO_API_KEY")) api_key = env;

  auto created = junjo::Client::create({.api_key = api_key, .base_url = base_url});
  if (!created) {
    std::cerr << "client construction failed: " << created.error().message << "\n";
    return 1;
  }
  auto client = std::move(created).value();

  std::cout << "GET " << base_url << "/v1/whoami ...\n";
  auto info = client.key_info();
  if (info) {
    std::cout << "key resolves to game " << info.value().game_id << "\n";
    return 0;
  }

  const junjo::Error& err = info.error();
  std::cout << "typed error: " << junjo::to_string(err.code) << ": " << err.message << "\n";
  if (err.status) std::cout << "  http status: " << *err.status << "\n";
  if (err.retry_after_seconds) {
    std::cout << "  retry after: " << *err.retry_after_seconds << "s\n";
  }
  return 2;
}
