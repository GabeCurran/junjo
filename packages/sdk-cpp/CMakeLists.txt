# Junjo.io SDK for C++
#
# Builds the JunjoIO::SDK library (static by default; BUILD_SHARED_LIBS
# is respected) and installs a find_package(JunjoIO) config package.
#
# Dependency policy (see README.md for the rationale):
#   - nlohmann/json: PRIVATE, header-only, FetchContent-pinned. Never
#     appears in a public header, so consumers keep their own JSON
#     choices.
#   - libcurl: only when JUNJO_BUILD_CURL_TRANSPORT is ON. A system
#     curl found via find_package(CURL) is preferred; otherwise a
#     pinned curl 8.9.1 is fetched and built HTTP-only. The link is
#     build-tree-scoped; the installed package re-resolves a system
#     curl via find_dependency, and a vendored curl under a static SDK
#     is installed into the prefix and imported directly (see the
#     install/export section and JunjoIOConfig.cmake.in).
#   - doctest: tests only, FetchContent-pinned.

cmake_minimum_required(VERSION 3.24)

project(JunjoIO
  VERSION 0.1.0
  DESCRIPTION "Junjo.io SDK for C++"
  LANGUAGES CXX)

include(FetchContent)
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

# Make option() in fetched subprojects honor our normal variables
# (CMP0077 NEW) instead of clobbering them with cache entries; without
# this, curl's option(BUILD_SHARED_LIBS ON) plants a sticky ON cache
# entry that flips this library to shared on the next configure.
set(CMAKE_POLICY_DEFAULT_CMP0077 NEW)

# ---------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------

option(JUNJO_BUILD_CURL_TRANSPORT "Build the bundled libcurl transport" ON)
# ON when the curl transport is built against the pinned FetchContent
# curl rather than a system libcurl. Baked into the installed package
# so JunjoIOConfig.cmake.in knows how to re-attach curl on the
# consumer side (see the install/export section below).
set(JUNJO_VENDORED_CURL OFF)
option(JUNJO_DEV "Developer mode: warnings as errors (used by tests/CI, never imposed on consumers)" OFF)
if(PROJECT_IS_TOP_LEVEL)
  option(JUNJO_BUILD_TESTS "Build the junjo_tests binary" ON)
else()
  option(JUNJO_BUILD_TESTS "Build the junjo_tests binary" OFF)
endif()

# ---------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------

# nlohmann/json v3.11.3, pinned by content hash. The official
# json.tar.xz release asset ships just the headers + CMake glue.
set(JSON_Install OFF CACHE BOOL "" FORCE)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d)
FetchContent_MakeAvailable(nlohmann_json)

if(JUNJO_BUILD_CURL_TRANSPORT)
  find_package(CURL QUIET)
  if(CURL_FOUND)
    message(STATUS "JunjoIO: curl transport using system libcurl ${CURL_VERSION_STRING}")
  else()
    message(STATUS "JunjoIO: curl transport building pinned curl 8.9.1 via FetchContent (HTTP only)")
    # Minimal HTTP(S)-only build: HTTP_ONLY disables every other
    # protocol; the extra toggles keep optional third-party deps from
    # being probed on the host system so the build is hermetic.
    set(BUILD_CURL_EXE OFF CACHE BOOL "" FORCE)
    set(BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
    set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
    set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(BUILD_LIBCURL_DOCS OFF CACHE BOOL "" FORCE)
    set(BUILD_MISC_DOCS OFF CACHE BOOL "" FORCE)
    set(ENABLE_CURL_MANUAL OFF CACHE BOOL "" FORCE)
    set(HTTP_ONLY ON CACHE BOOL "" FORCE)
    set(CURL_DISABLE_INSTALL ON CACHE BOOL "" FORCE)
    set(CURL_ENABLE_EXPORT_TARGET OFF CACHE BOOL "" FORCE)
    set(CURL_USE_LIBPSL OFF CACHE BOOL "" FORCE)
    set(CURL_USE_LIBSSH2 OFF CACHE BOOL "" FORCE)
    set(CURL_ZLIB OFF CACHE BOOL "" FORCE)
    set(CURL_BROTLI OFF CACHE BOOL "" FORCE)
    set(CURL_ZSTD OFF CACHE BOOL "" FORCE)
    # TLS: OS-native backends so no CA bundle needs shipping. Schannel
    # on Windows, Secure Transport on Apple; elsewhere curl's default
    # probe (typically OpenSSL) applies.
    if(WIN32)
      set(CURL_USE_SCHANNEL ON CACHE BOOL "" FORCE)
    elseif(APPLE)
      set(CURL_USE_SECTRANSP ON CACHE BOOL "" FORCE)
    endif()
    FetchContent_Declare(curl
      URL https://github.com/curl/curl/releases/download/curl-8_9_1/curl-8.9.1.tar.xz
      URL_HASH SHA256=f292f6cc051d5bbabf725ef85d432dfeacc8711dd717ea97612ae590643801e5)
    # The vendored curl is always built static (hermetic, nothing to
    # install next to a consumer). Shadow BUILD_SHARED_LIBS for the
    # subtree, then restore an EXPLICIT normal variable: curl's own
    # option(BUILD_SHARED_LIBS ON) plants an ON cache entry that would
    # otherwise leak into our add_library the moment the shadow is
    # removed.
    if(BUILD_SHARED_LIBS)
      set(_junjo_saved_build_shared_libs ON)
    else()
      set(_junjo_saved_build_shared_libs OFF)
    endif()
    set(BUILD_SHARED_LIBS OFF)
    # The subtree's static archives feed a shared junjo library when
    # BUILD_SHARED_LIBS is ON, which requires position-independent
    # objects on ELF platforms. Shadow PIC for the subtree the same
    # way, restoring the caller's setting (set or unset) afterwards.
    if(DEFINED CMAKE_POSITION_INDEPENDENT_CODE)
      set(_junjo_saved_pic "${CMAKE_POSITION_INDEPENDENT_CODE}")
    endif()
    set(CMAKE_POSITION_INDEPENDENT_CODE ON)
    FetchContent_MakeAvailable(curl)
    set(BUILD_SHARED_LIBS ${_junjo_saved_build_shared_libs})
    unset(_junjo_saved_build_shared_libs)
    if(DEFINED _junjo_saved_pic)
      set(CMAKE_POSITION_INDEPENDENT_CODE "${_junjo_saved_pic}")
      unset(_junjo_saved_pic)
    else()
      unset(CMAKE_POSITION_INDEPENDENT_CODE)
    endif()
    set(JUNJO_VENDORED_CURL ON)
    # Rename the vendored archive to a predictable, junjo-owned file
    # name so the installed package can reference it without guessing
    # at curl's platform-dependent naming, and so it can never be
    # mistaken for (or clobber) a real libcurl in the same prefix.
    set_target_properties(libcurl_static PROPERTIES
      PREFIX ""
      OUTPUT_NAME junjo_vendored_curl
      SUFFIX "${CMAKE_STATIC_LIBRARY_SUFFIX}"
      DEBUG_POSTFIX "-d")
  endif()
endif()

# ---------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------

add_library(junjo_sdk
  src/audit.cpp
  src/bans.cpp
  src/client.cpp
  src/error.cpp
  src/events.cpp
  src/executor.cpp
  src/friends.cpp
  src/groups.cpp
  src/hmac_sha256.cpp
  src/invitations.cpp
  src/members.cpp
  src/request_executor.cpp
  src/roles.cpp
  src/sse_parser.cpp
  src/transport.cpp
  src/types.cpp
  src/url.cpp
  src/webhooks.cpp
  src/wire.cpp)
add_library(JunjoIO::SDK ALIAS junjo_sdk)

set_target_properties(junjo_sdk PROPERTIES
  OUTPUT_NAME junjo
  EXPORT_NAME SDK
  # Debug and Release must be co-installable into one prefix; without
  # a postfix the second install clobbers lib/junjo.lib while both
  # per-config target files keep pointing at the survivor.
  DEBUG_POSTFIX "-d"
  # Makes BUILD_SHARED_LIBS=ON viable on MSVC without dllexport
  # decorations; a no-op for static builds and non-Windows platforms.
  WINDOWS_EXPORT_ALL_SYMBOLS ON)

target_compile_features(junjo_sdk PUBLIC cxx_std_20)

target_include_directories(junjo_sdk PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)

# BUILD_INTERFACE-scoped on purpose: nlohmann is header-only and fully
# compiled into the library, so the installed export must not carry it.
target_link_libraries(junjo_sdk PRIVATE
  $<BUILD_INTERFACE:nlohmann_json::nlohmann_json>)

# std::thread machinery (executors, SSE subscription threads) appears
# in public headers, so the dependency is PUBLIC; -pthread must reach
# consumers on platforms that need it. The installed package
# re-resolves it via find_dependency(Threads).
find_package(Threads REQUIRED)
target_link_libraries(junjo_sdk PUBLIC Threads::Threads)

if(JUNJO_BUILD_CURL_TRANSPORT)
  target_sources(junjo_sdk PRIVATE src/curl_transport.cpp)
  target_compile_definitions(junjo_sdk PRIVATE JUNJO_HAS_CURL_TRANSPORT)
  if(BUILD_SHARED_LIBS)
    # A shared junjo library links curl at build time. PRIVATE links of
    # a shared library do not enter INTERFACE_LINK_LIBRARIES, so the
    # install export stays clean even when curl came from FetchContent.
    target_link_libraries(junjo_sdk PRIVATE CURL::libcurl)
  else()
    # A static archive has no link step: it only needs curl's headers
    # (and CURL_STATICLIB when curl is static) to compile
    # curl_transport.cpp. Deliberately NOT target_link_libraries: a
    # PRIVATE link on a static lib lands in INTERFACE_LINK_LIBRARIES
    # as $<LINK_ONLY:...>, and a FetchContent-built libcurl is a plain
    # build target that install(EXPORT) cannot reference. Final
    # consumers get curl re-attached by JunjoIOConfig.cmake.in via
    # find_dependency; build-tree consumers (tests, add_subdirectory
    # users) link CURL::libcurl themselves.
    target_include_directories(junjo_sdk PRIVATE
      $<TARGET_PROPERTY:CURL::libcurl,INTERFACE_INCLUDE_DIRECTORIES>)
    target_compile_definitions(junjo_sdk PRIVATE
      $<TARGET_PROPERTY:CURL::libcurl,INTERFACE_COMPILE_DEFINITIONS>)
  endif()
endif()

# Warnings: strict for our own translation units, never exported to
# consumers. JUNJO_DEV escalates to errors for tests/CI.
set(JUNJO_MSVC_WARNINGS /W4 /permissive-)
set(JUNJO_OTHER_WARNINGS -Wall -Wextra -Wpedantic)
if(JUNJO_DEV)
  list(APPEND JUNJO_MSVC_WARNINGS /WX)
  list(APPEND JUNJO_OTHER_WARNINGS -Werror)
endif()
target_compile_options(junjo_sdk PRIVATE
  $<$<CXX_COMPILER_ID:MSVC>:${JUNJO_MSVC_WARNINGS}>
  $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:${JUNJO_OTHER_WARNINGS}>)

# ---------------------------------------------------------------------
# Install + export: find_package(JunjoIO) -> JunjoIO::SDK
# ---------------------------------------------------------------------

install(TARGETS junjo_sdk
  EXPORT JunjoIOTargets
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

install(FILES
  include/junjo/audit.hpp
  include/junjo/bans.hpp
  include/junjo/cancellation.hpp
  include/junjo/client.hpp
  include/junjo/error.hpp
  include/junjo/events.hpp
  include/junjo/executor.hpp
  include/junjo/export.hpp
  include/junjo/friends.hpp
  include/junjo/groups.hpp
  include/junjo/invitations.hpp
  include/junjo/members.hpp
  include/junjo/pagination.hpp
  include/junjo/preconditions.hpp
  include/junjo/result.hpp
  include/junjo/roles.hpp
  include/junjo/transport.hpp
  include/junjo/types.hpp
  include/junjo/webhooks.hpp
  DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/junjo)
if(JUNJO_BUILD_CURL_TRANSPORT)
  install(FILES include/junjo/curl_transport.hpp
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/junjo)
endif()

install(EXPORT JunjoIOTargets
  NAMESPACE JunjoIO::
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/JunjoIO)

# A vendored curl under a static SDK is the one arrangement where the
# consumer's final link still needs curl object code that no installed
# target provides. Close the gap by installing the vendored archive
# next to the SDK and baking enough facts into the config file for it
# to reconstruct an imported target: the per-config file names and the
# system libraries curl's archive needs (captured from the build
# target; entries arrive $<LINK_ONLY:...>-wrapped, which is exactly
# what an imported target's INTERFACE_LINK_LIBRARIES wants). Shared
# SDK builds resolve curl into the library at its own link step, and
# system-curl builds re-resolve via find_dependency, so neither
# installs anything extra.
if(JUNJO_VENDORED_CURL AND NOT BUILD_SHARED_LIBS)
  install(FILES $<TARGET_FILE:libcurl_static>
    DESTINATION ${CMAKE_INSTALL_LIBDIR})
  get_target_property(JUNJO_VENDORED_CURL_DEPS libcurl_static
    INTERFACE_LINK_LIBRARIES)
  if(NOT JUNJO_VENDORED_CURL_DEPS)
    set(JUNJO_VENDORED_CURL_DEPS "")
  endif()
  # The captured list may name imported OpenSSL targets (a vendored
  # curl built where the default TLS probe picked OpenSSL). Those
  # names do not exist on the consumer side unless the generated
  # config runs find_dependency(OpenSSL) first, so emit that line
  # exactly when the list references them. Plain system library names
  # (ws2_32 and friends on Windows) need no lookup and pass through
  # unchanged.
  set(JUNJO_VENDORED_CURL_FIND_OPENSSL "")
  foreach(_junjo_curl_dep IN LISTS JUNJO_VENDORED_CURL_DEPS)
    string(REGEX REPLACE "^\\$<LINK_ONLY:(.*)>$" "\\1"
      _junjo_curl_dep "${_junjo_curl_dep}")
    if(_junjo_curl_dep MATCHES "^OpenSSL::")
      set(JUNJO_VENDORED_CURL_FIND_OPENSSL "find_dependency(OpenSSL)")
    endif()
  endforeach()
  unset(_junjo_curl_dep)
endif()
set(JUNJO_VENDORED_CURL_RELEASE_FILE
  "junjo_vendored_curl${CMAKE_STATIC_LIBRARY_SUFFIX}")
set(JUNJO_VENDORED_CURL_DEBUG_FILE
  "junjo_vendored_curl-d${CMAKE_STATIC_LIBRARY_SUFFIX}")
if(BUILD_SHARED_LIBS)
  set(JUNJO_SDK_SHARED ON)
else()
  set(JUNJO_SDK_SHARED OFF)
endif()
set(JUNJO_INSTALL_LIBDIR ${CMAKE_INSTALL_LIBDIR})

configure_package_config_file(
  cmake/JunjoIOConfig.cmake.in
  ${CMAKE_CURRENT_BINARY_DIR}/JunjoIOConfig.cmake
  INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/JunjoIO
  PATH_VARS JUNJO_INSTALL_LIBDIR)
write_basic_package_version_file(
  ${CMAKE_CURRENT_BINARY_DIR}/JunjoIOConfigVersion.cmake
  VERSION ${PROJECT_VERSION}
  # Pre-1.0, minor bumps may break; widens to SameMajorVersion at 1.0.
  COMPATIBILITY SameMinorVersion)
install(FILES
  ${CMAKE_CURRENT_BINARY_DIR}/JunjoIOConfig.cmake
  ${CMAKE_CURRENT_BINARY_DIR}/JunjoIOConfigVersion.cmake
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/JunjoIO)

# License and third-party notices travel with every installed tree.
install(FILES LICENSE THIRD_PARTY_NOTICES.md
  DESTINATION ${CMAKE_INSTALL_DATAROOTDIR}/doc/JunjoIO)

# ---------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------

if(JUNJO_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
