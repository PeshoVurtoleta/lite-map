# Changelog

All notable changes to `@zakkster/lite-map` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] -- 2026-07-16

### Added -- tail fast-paths for `mapArray`

A position-aligned common-prefix scan by key classifies the dominant real-world
mutations -- **append**, **pop**, and **in-place value churn** (feeds, logs,
push/pop) -- *before* the general keyed diff. When the prefix is intact, the
general path (its per-item `byKey.get`, scratch swap and full retire scan) is
skipped entirely: the only structural work is O(delta) at the tail, and the
`byKey` Map and the scope pool never churn.

- **Correctness-preserving.** Detection is a pure key scan with no side effects,
  so any non-tail shape (prepend, reorder, middle insert/remove) falls through to
  the unchanged general path. The fast-paths produce byte-identical results to the
  general diff -- the property/model cross-check in the suite covers interleaved
  tail ops and reorders.
- **No new API.** `mapArray` / `indexArray` signatures are unchanged;
  `indexArray` already had O(delta) tail grow/shrink in 1.0.

### Verified

- **Gate:** 10,000 push/pop cycles on a warm list are zero-GC (`poolGrowths` and
  `totalAllocations` flat vs a roomy registry's counters); an append to an N-row
  list preserves all N survivor scopes and re-runs only the appended row's index
  effect.
- 12 new tests (`test/tail_test.mjs`) plus the adversarial suite
  (`test/torture_test.mjs`); **45 tests total**, `node --test`.

### Honest non-claim

- The prefix scan itself is O(min(n, prevN)) key comparisons. What stays flat
  versus list length is the *allocation, `byKey` Map churn and scope-move* cost --
  the parts that actually pull from the pool or move work.

### Fixed

Found by the adversarial suite below during the 1.1.0 prepublish review. Both are
silent: nothing throws, the rendered order stays correct, and only a scope's
identity is quietly lost.

- **A duplicate key cost a UNIQUE key its scope, and the damage outlived the
  duplicate.** Keys are documented as unique, but a real list transiently breaks
  that (a paginated fetch that overlaps, a join that fans out, an id assigned
  twice). Registering a duplicate in `byKey` overwrote the entry of the slot that
  legitimately owned that key. When the duplicate later left, `retire()` deleted
  the entry -- it matched the duplicate -- leaving the ORIGINAL slot live but
  unreachable through `byKey`. The next reorder then classified that survivor as
  new and handed it a fresh scope: its effects re-ran and its DOM node was
  rebuilt, on a key that was unique again by then. A duplicate is now
  self-contained: it acquires a scope but is not registered, so it cannot evict
  anyone, and `retire()`'s existing `byKey.get(s.key) === s` guard already
  declines to delete an entry it does not own. Duplicates remain **unsupported**
  in the sense that only the first occurrence is addressable by key -- but they
  can no longer corrupt the identity of a key that is unique.
- **A pooled scope could strand a `byKey` entry under its previous key.**
  `retire()` clears a slot's entry, but declines when that entry was overwritten
  (by the bug above, or any future path). Re-keying a reused scope without
  re-checking left an entry pointing at a slot that no longer held that key.
  `acquire()` now clears a pooled slot's own stale entry before re-keying it.

### Torture (opt-in: `npm run test:torture`)

- `test/torture_test.mjs` -- adversarial regression suite, part of the normal
  `npm test`. Pins the duplicate-key identity defects above (including a
  300-seed fuzz over a deliberately duplicate-prone keyspace) alongside the
  scope/pool accounting invariants.
- `bench/torture/maparray-fuzzer.mjs` -- seeded, oracle-checked fuzz: mapArray under random
  append/pop/prepend/insert/remove/reorder/value-churn with survivor-scope (sid)
  stability and the `slots[i].index === i` invariant; indexArray length/value
  fuzz; and a long tail push/pop oscillation that stays pool-flat. Scale with
  `TORTURE_SCALE`. Dev-only; not in `files[]`.

## [1.0.0] -- 2026-06-26

Initial public release. Zero-GC keyed list reconciliation for
`@zakkster/lite-signal`: two primitives that map a reactive array to one reactive
scope per item and reconcile by MOVING and REBINDING scopes -- reusing retired
scopes from a free-list -- instead of rebuilding them.

### Added -- `indexArray(list, (item, index) => O, opts?)`

POSITION-keyed. `item` is an accessor (the value at this slot can change); `index`
is a plain number (the slot is stable).

- **Value churn at a stable length is zero-GC**: each changed slot is one
  `itemSig.set`, and only that slot's own effects re-run. No reconcile, no
  allocation.
- Growing appends new slots; shrinking parks tail slots on a LIFO free-pool.
  Tail re-growth reuses a parked slot when its index matches (push/pop at the end
  is zero-GC). A reused slot whose index would not match is disposed and rebuilt,
  keeping the plain-number `index` correct.
- `opts.maxPool` caps retained parked slots (default: unbounded).

### Added -- `mapArray(list, (item, index) => O, opts?)`

ITEM-keyed, **by-accessor**: both `item` and `index` are accessors.

- Survivors are reused in place: a moved survivor gets `idxSig.set` (zero-GC); a
  survivor whose item changed under a stable key gets `itemSig.set`.
- Removed items' scopes are retired to a free-list. Inserts reuse a retired scope
  by setting its item and index signals (zero-GC when the pool is warm), or build
  one when the pool is empty.
- `opts.key` selects identity (default: reference identity, the item itself). Keys
  must be unique within the list. `opts.maxPool` caps retained retired scopes.

### Added -- `createMapper(registry)`

Binds both primitives to an explicit registry (e.g. one from `createRegistry`).
The default exports `mapArray` / `indexArray` are bound to the default registry.

### The fork this release ships, and what is deferred

- **by-accessor is the 1.0 design.** Passing the changing dimension as an accessor
  is what lets a retired scope be reused for a new item by setting a signal rather
  than re-running `mapFn`. A **by-value `mapArray`** (item as a plain value,
  Solid-style ergonomics) cannot reuse a scope for a new item, so its inserts would
  pull from the pool; it is planned as an opt-in, with by-accessor remaining the
  zero-GC default.
- **LIS minimal-move ordering is deferred.** 1.0 reorders are correct but not
  minimal (more index updates than the theoretical floor). A
  longest-increasing-subsequence pass is planned.
- **Append/pop fast-paths are deferred.** The general keyed diff is O(n) and
  correct; dedicated fast-paths for common tail mutations are planned.

### Output and ownership

- `mapped()` returns the outputs in source order as **one persistent array, mutated
  in place** (zero per-change allocation). Read it fresh each reactive run; do not
  retain or reference-compare it. It fires only on a real structural change
  (membership/order), not on value-only churn.
- Each item owns a `createScope` scope (its `mapFn` effects/computeds cascade on
  disposal). Per-item scopes and the reconcile driver are **detached from the
  calling scope**, so an enclosing scope re-running never tears the list down. The
  caller owns teardown via `mapped.dispose()` (stops the driver, disposes every
  live and parked scope including the item/index signals the scope does not own,
  and the output signal). There is no auto-cleanup.

### Dependency

- Peer `@zakkster/lite-signal` `^1.6.0-preview.0`. lite-map is built on
  `createScope`, the detached per-item-subtree disposal primitive introduced in
  `1.6.0-preview.0`. (When a stable `1.6.0` ships, the range continues to match it;
  it may be tightened to `^1.6.0` at that point.)

### Zero-GC, verified

Against the engine's pool counters (`poolGrowths` / `totalAllocations`), flat after
warm-up:

- `indexArray` value churn at a stable length -- 20,000 updates, flat.
- `mapArray` reorder / move -- `idxSig.set` on shifted survivors.
- `mapArray` insert/remove with a warm pool -- 5,000 iterations, flat.
- `indexArray` tail grow/shrink -- serviced by the free-pool.

**Honest non-claims:** growth past the previous high-water mark pulls scopes from
the pool; the keyed `byKey` Map mutates on actual key changes (a JS-heap allocation
the pool counters do not see -- a reorder touches no key, so no Map churn); the
user's `mapFn` body is the caller's. `createScope` cascades effects/computeds but
not signals, so a bare signal created inside `mapFn` is not auto-disposed on
teardown -- prefer effects/computeds, or dispose it yourself.

### Tested

- 10 tests under `node --test --expose-gc` against `1.6.0-preview.0`: output order
  and in-place value update for both primitives; `indexArray` value-churn zero-GC
  and tail push/pop reuse; `mapArray` keyed reorder (survivors move, scopes reused),
  remove-then-insert scope reuse, full reconciliation correctness
  (append/prepend/remove-middle/reorder/replace/clear), custom-key item refresh,
  disposal returning the engine to baseline, and reorder + warm-pool churn zero-GC.
- ESM only; `node:test`; `sideEffects: false`; ASCII source; `Map.d.ts` validated
  under `tsc --strict`.
