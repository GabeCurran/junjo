# Permission conformance vectors

`permission-vectors.json` holds the answers every Junjo permission resolver must give: the server's, and any SDK that resolves locally. A resolver passes when it reproduces every case, key and graph vector below.

Inputs are given as a caller would write them. Implementations normalize them exactly as their write and check paths do: permission keys with the mode's key rule (lowercased with an ASCII-only fold in `nodes` mode, verbatim in `exact` mode), and context values with the ASCII-only fold in every mode.

## Top-level fields

| Field | Meaning |
| --- | --- |
| `version` | Format version. Still `1`: every field added since is optional, and a case without them means what it always meant. |
| `cases` | Resolution cases, below. |
| `keys` | `{ mode, key, valid }`: whether a permission key is accepted for storage in the mode. |
| `graphs` | `{ name, parents, valid }`: whether a role-parent graph is acyclic. |
| `contextConfigs` | `{ name, contexts, valid }`: whether a `permissions.contexts` game config is accepted. |
| `entryContexts` | `{ context, valid, canonical? }`: whether a context is accepted on an entry or a check, and for a valid one its canonical storage key. |

## A case

| Field | Meaning |
| --- | --- |
| `name`, `note` | Description only. |
| `modes` | The permission modes the case runs in; run it once per mode. |
| `contexts` | Optional. The game's `permissions.contexts` (context key to `{ inherit: { value: [parent, ...] } }`). Absent means no inheritance. |
| `roles` | Role id to `{ priority, entries, contextEntries?, parents? }`. `entries` maps a key to its value (`true` grants, `false` denies) and holds the role's global entries. `contextEntries` is an optional list of `{ permission, value, context }`, each limited to a non-empty context. `parents` lists the role ids the role inherits from. |
| `member` | `{ roles, overrides?, contextOverrides? }`. `roles` are the roles the member holds directly. `overrides` maps a key to the member's global override. `contextOverrides` lists contextual overrides like `contextEntries`. |
| `checks` | The checks to run, below. |

Role ids are compared as strings for the tie-break (higher priority first, then the greater id).

## A check

| Field | Meaning |
| --- | --- |
| `permission` | The permission checked, as a caller writes it. |
| `context` | Optional. The check's context. Absent means the check sends none, so only global entries apply. |
| `allowed`, `source` | The expected answer. |
| `via` | The deciding role's id, present exactly when `source` is `role`. |
| `decidedContext` | The expected `context` on the result: the deciding entry's context, folded. Absent means the result carries no `context` (a global entry decided, or nothing did). |

## Context rules the vectors exercise

- A context key matches `^[a-z][a-z0-9_]{0,31}$`; an entry or a check has at most 2 keys.
- A value is 1 to 64 UTF-16 code units with no control characters (Unicode category Cc), and folds `A-Z` to `a-z` and nothing else.
- The canonical key is `""` for an empty context, else the JSON array of `[key, foldedValue]` pairs sorted by key, serialized without whitespace.
- `contexts` is refused for a cycle (after folding), a chain longer than 16 steps, more than 256 values listing parents under one key, more than 8 parents on one value, two values equal after folding, or an invalid key or value.
- `chain(key, v)` maps every value reachable from `v` through `inherit` to its shortest distance (`v` is 0, its parents 1, and so on).
- An entry with context `E` applies to a check with context `C` when every `(k, ev)` in `E` has `k` in `C` and `ev` in `chain(k, C[k])`. Its score is `(|E|, sum of distances)`; a global entry always applies and scores `(0, 0)`.
- Resolution walks layers (the member's overrides, then directly held roles, then parents by distance). The first layer with an applicable entry for a candidate key decides. Inside it, the most matched keys win, then the smallest distance sum, then key specificity, then deny.
