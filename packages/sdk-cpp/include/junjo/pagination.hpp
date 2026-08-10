// Junjo.io SDK for C++
//
// Cursor-pagination helper: junjo::paginate drains every page of a
// cursor-paginated listing without the caller hand-rolling the cursor
// loop.
//
// Design note: of the candidate shapes (an input-range cursor
// iterator, a coroutine generator, a callback loop) the callback free
// function wins for this SDK. Coroutines are out of scope for the
// foundation; and a range/iterator would have to smuggle the mid-walk
// Error out-of-band (iterators cannot return Result), leaving the
// caller to remember a post-loop error check that the type system
// cannot enforce. The callback shape keeps the SDK's one invariant
// intact: every fallible operation returns exactly one Result, and
// [[nodiscard]] makes it hard to ignore. Cancellation needs no extra
// plumbing here; the CancellationToken travels inside the caller's
// fetch function (see the example), and a cancelled fetch
// short-circuits the walk like any other error.
#pragma once

#include <optional>
#include <string>
#include <type_traits>
#include <utility>

#include "junjo/result.hpp"
#include "junjo/types.hpp"

namespace junjo {

namespace detail {

// Extracts T from a fetch function returning Result<Page<T>>. A
// non-matching fetch type fails the static_assert in paginate with a
// readable message instead of template soup.
template <typename R>
struct PageResultTraits {
  static constexpr bool is_page_result = false;
};

template <typename T>
struct PageResultTraits<Result<Page<T>>> {
  static constexpr bool is_page_result = true;
  using ItemType = T;
};

}  // namespace detail

// Walks every page of a cursor-paginated listing, invoking `per_item`
// for each item in order.
//
//   fetch_page: (const std::optional<std::string>& cursor)
//                   -> Result<Page<T>>
//     Invoked with nullopt first, then each page's next_cursor.
//     Typically a lambda closing over an Api handle, its options, and
//     a CancellationToken.
//   per_item: (T&&) -> void, or (T&&) -> bool where returning false
//     stops the walk early (the walk still counts as success).
//
// Returns success after the last page (absent next_cursor) or an early
// stop; returns the first error unchanged and fetches no further pages
// (error short-circuit, including ErrorCode::Cancelled from a
// cancelled fetch).
//
// Example, draining every public group:
//
//   junjo::GroupsApi groups = client.groups();
//   junjo::Result<void> walked = junjo::paginate(
//       [&](const std::optional<std::string>& cursor) {
//         junjo::ListGroupsOptions options;
//         options.cursor = cursor;
//         return groups.list(options, token);
//       },
//       [&](junjo::Group&& group) { names.push_back(group.name); });
template <typename FetchPage, typename PerItem>
[[nodiscard]] Result<void> paginate(FetchPage&& fetch_page, PerItem&& per_item) {
  using FetchResult = std::invoke_result_t<FetchPage&, const std::optional<std::string>&>;
  using Traits = detail::PageResultTraits<FetchResult>;
  static_assert(Traits::is_page_result,
                "junjo::paginate: fetch_page must return junjo::Result<junjo::Page<T>>");
  using Item = typename Traits::ItemType;
  using PerItemResult = std::invoke_result_t<PerItem&, Item&&>;
  static_assert(std::is_void_v<PerItemResult> || std::is_same_v<PerItemResult, bool>,
                "junjo::paginate: per_item must return void or bool (false = stop early)");

  std::optional<std::string> cursor;
  while (true) {
    FetchResult fetched = fetch_page(cursor);
    if (!fetched.has_value()) {
      return std::move(fetched).error();
    }
    Page<Item> page = std::move(fetched).value();
    for (Item& item : page.items) {
      if constexpr (std::is_void_v<PerItemResult>) {
        per_item(std::move(item));
      } else {
        if (!per_item(std::move(item))) {
          return Result<void>::ok();
        }
      }
    }
    if (!page.next_cursor.has_value()) {
      return Result<void>::ok();
    }
    cursor = std::move(page.next_cursor);
  }
}

}  // namespace junjo
