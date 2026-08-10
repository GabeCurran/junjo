# Junjo.io SDK for C++: test binary.

# doctest 2.4.11, pinned by content hash. Chosen over Catch2/GTest for
# compile speed: a single header, and assertions that do not explode
# template instantiation time across a growing suite.
set(DOCTEST_NO_INSTALL ON CACHE BOOL "" FORCE)
set(DOCTEST_WITH_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(doctest
  URL https://github.com/doctest/doctest/archive/refs/tags/v2.4.11.tar.gz
  URL_HASH SHA256=632ed2c05a7f53fa961381497bf8069093f0d6628c5f26286161fbd32a560186)
FetchContent_MakeAvailable(doctest)

add_executable(junjo_tests
  main.cpp
  test_async.cpp
  test_audit.cpp
  test_bans.cpp
  test_client.cpp
  test_concurrency.cpp
  test_enums.cpp
  test_error.cpp
  test_events.cpp
  test_executor.cpp
  test_friends.cpp
  test_groups.cpp
  test_invitations.cpp
  test_members.cpp
  test_pagination.cpp
  test_permissions.cpp
  test_roles.cpp
  test_sse_parser.cpp
  test_transport.cpp
  test_url.cpp
  test_webhook_verify.cpp
  test_webhooks.cpp)

target_link_libraries(junjo_tests PRIVATE
  JunjoIO::SDK
  doctest::doctest
  nlohmann_json::nlohmann_json)
if(JUNJO_BUILD_CURL_TRANSPORT AND NOT BUILD_SHARED_LIBS)
  # The static junjo archive contains curl-calling objects but does not
  # carry a curl link edge (see the export note in the top-level
  # CMakeLists); the final binary supplies it.
  target_link_libraries(junjo_tests PRIVATE CURL::libcurl)
endif()

# The tests exercise internal utilities (url.hpp, request_executor.hpp)
# straight from the source tree; they are not part of the installed
# surface.
target_include_directories(junjo_tests PRIVATE ${PROJECT_SOURCE_DIR}/src)

# doctest's forward-declared std::ostream trick is non-conforming and
# breaks against the MSVC STL; have it include the real headers.
target_compile_definitions(junjo_tests PRIVATE DOCTEST_CONFIG_USE_STD_HEADERS)

target_compile_options(junjo_tests PRIVATE
  $<$<CXX_COMPILER_ID:MSVC>:${JUNJO_MSVC_WARNINGS}>
  $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:${JUNJO_OTHER_WARNINGS}>)

include(${doctest_SOURCE_DIR}/scripts/cmake/doctest.cmake)
doctest_discover_tests(junjo_tests)
