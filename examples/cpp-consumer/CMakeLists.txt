# Junjo.io SDK for C++: external consumer example.
#
# A standalone project, deliberately NOT part of the monorepo build.
# It consumes the SDK exactly the way a game backend would: install the
# SDK to a prefix, then find_package(JunjoIO) here. See README.md for
# the full walkthrough.
#
# Configure with the install prefix on the package path, e.g.:
#   cmake -S . -B build -DCMAKE_PREFIX_PATH=/path/to/junjo-install

cmake_minimum_required(VERSION 3.24)

project(JunjoConsumerExample LANGUAGES CXX)

find_package(JunjoIO 0.1 REQUIRED)

add_executable(junjo-consumer main.cpp)
target_link_libraries(junjo-consumer PRIVATE JunjoIO::SDK)
