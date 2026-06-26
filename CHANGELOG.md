# Changelog

All notable changes to `@zakkster/lite-map` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

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
