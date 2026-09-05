# Changelog

All notable changes to `@zakkster/lite-map` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.4.0] -- unreleased

DOCS-ONLY: Map.js and Map.d.ts are byte-identical to 1.3.0 (no API, no
behavior change). Session facts recorded here per the C3 plan:
- M-06 STAYS OPEN: as of 2026-09-05 the registry has no stable lite-signal
  >= 1.6.0 (latest 1.5.0; beta dist-tag -> 1.6.0-beta-1, the dev pin;
  highest 1.6.x prerelease 1.6.0-preview.2), so the stable "^1.6.0" floor
  cannot land and the dev pin stays 1.6.0-beta-1. The PEER floor moved
  same-day to "^1.6.0-beta-1" by author correction (see the peer-floor
  Changed entry below) -- to the tested prerelease, not to any stable.
  Re-verify the export union and the full gate when stable 1.6.0 ships,
  then floor both pins to "^1.6.0".
- fact-12 re-probe (lite-signal 1.6.0-beta-1): re-entrant set reflects synchronously = yes
  (differs from the observation registered at C2; non-gating, lite-signal's
  concern, re-probe on stable 1.6.0).

### Added
- `bench/lis-probe.mjs` + dev script `bench:lis` (repo-only; `bench/` is not
  in `files[]` -- the tarball is unchanged at 7 files). Deterministic 5-shape
  probe (seed 0x9e3779b9, n=1000) measuring per reorder shape: idxSig.set
  writes (moved), output-array slot stores, the classic `n - LIS` move floor,
  and `redundant = n - moved`. Measured on lite-signal 1.6.0-beta-1: moved
  rotate=1000 / reverse=1000 / shuffle=998 / adjacent-swap=2 /
  moves-25pct=929; redundant 0 / 0 / 2 / 998 / 71; n-LIS 1 / 999 / 941 / 1 /
  226.
- `decisions/0002-lis-ordering.md` (repo-only): M-01 (LIS minimal-move)
  closed as DOCUMENTED AS MET on criterion A-1 (`redundant/n >= 0.50` on only
  1/5 shapes). `n - LIS` is a move-operation floor for insertion-ordered
  containers; the positionally-indexed `mapped()` output has store floor
  `n - redundant`, and the recoverable cost is idempotent plain stores into
  one persistent array -- invisible to every zero-GC witness this package
  owns.

### Changed
- README "Not in 1.0" and the llms.txt gotcha: the LIS bullet no longer
  promises a planned pass; it records the measured numbers and points at
  `decisions/0002-lis-ordering.md`.

### Changed -- peer floor corrected to the build the suite actually runs against

- **`peerDependencies`: `@zakkster/lite-signal` `^1.6.0-preview.2` ->
  `^1.6.0-beta-1`** (amends M-06's interim pin; the planned `^1.6.0` narrowing
  once a stable ships is unchanged). `1.6.0-beta-1` is the registry's current
  `1.6.0` head (dist-tag `beta`) and the dev pin the test suite has run against
  since 1.1.1 (the closest build exporting BOTH `createScope` and `getOwner`,
  which the lite-leak witness needs) -- but semver compares prerelease
  identifiers lexically, so `beta-1` sorts BELOW `preview.2` and the tested
  build did not satisfy the published range. That was lite-map's own share of
  1.1.1's documented `--legacy-peer-deps` wart; with the floor at
  `^1.6.0-beta-1` the dev pin satisfies lite-map's peer (npm's ERESOLVE report
  no longer lists a lite-map edge). A full dev install STILL needs
  `--legacy-peer-deps` for one upstream edge: `lite-leak@1.10.0` peers on
  lite-signal `>=1.5.0-beta.3 <2.0.0`, and npm's same-tuple prerelease rule
  admits no `1.6.0-*` prerelease into that range (`rc.*` included) -- stable
  `1.6.0` does satisfy it, so the residue clears at the stable `^1.6.0`
  re-pin (M-06), or earlier if lite-leak widens its peer with
  `|| >=1.6.0-0 <2.0.0`.
  (`lite-gc-profiler@1.16.0` declares no peers -- lite-leak is the only edge.)
- Range facts (checked against npm's semver): `^1.6.0-beta-1` admits `beta-1`,
  `preview.0..2` (a side effect of the same lexical ordering; every preview
  carries `createScope`, the one primitive lite-map is built on), the imminent
  `1.6.0-rc.*`, and stable `1.6.0` -- the announced rc promotion therefore
  needs no further range change. `alpha.*`, `beta`, and `beta-0` sort below the
  floor and stay excluded.
- Docs state the same floor: `llms.txt` (peer line + the `createMapper` entry),
  README's peer blockquote, and the harness note in
  `test/harness_map_test.mjs`. `Map.js` is byte-identical -- no runtime change.

## [1.3.0] -- 2026-09-05

By-value `mapArray` (M-03), an explicit opt-in. `mapArray(list, mapFn, { byValue:
true })` calls `mapFn` with the PLAIN item (Solid-style) and an index accessor. The
by-accessor mode (byValue absent/false) is the zero-GC default and is byte-for-byte
unchanged -- a sibling reconcile family is selected once at creation, so the
accessor function bodies gain exactly one dispatch line and nothing else.

### Added -- `{ byValue: true }` on `mapArray`

- **Plain-item mapFn.** `mapFn(item, index)` receives `item` as the value itself
  (no `item()` call) and `index` as an accessor. Keys are the item by REFERENCE
  identity (SameValueZero): `-0` and `0` are the same key (not an item change), and
  the same reference twice is a contained duplicate that never evicts the owner.
- **Cost, pinned at the call site.** A by-value view bakes the item into its
  closure, so there is no signal to redirect it: a MOVE (same item, new index)
  rides `idxSig.set` with NO `mapFn` re-run (pool-flat), but an INSERT re-runs
  `mapFn` exactly once and pulls a fixed **`k = 3` engine nodes** (the scope, the
  index signal, one index effect for the fixture mapFn) from the pool. Gated (T6
  phase 4): the warm-reorder window shows `poolGrowths` / `totalAllocations` deltas
  **0** with zero `mapFn` re-runs; `k` is calibrated once and asserted `==` on every
  insert, whether or not a scope was retired, under a hard ceiling of 8 nodes.
- **No free-list.** A parked by-value view is baked to its old item and can never
  serve a new one, so removals dispose IMMEDIATELY and `stats().parked` is always
  `0` (a by-value invariant). `stats()` otherwise reads `{ live, 0, highWater }`
  identically -- the replace-all `prevN + n` transient is still recorded.
- **Door (fail closed, ASCII, did-you-mean).** `{ byValue: true }` throws at
  creation when combined with `key` or `maxPool`, and when `byValue` is truthy but
  not exactly `true` (no silent ignore). Unknown-key validation for the accessor
  mode remains a registered, separate gap.
- **Types.** A `mapArray` overload ordered first -- `{ byValue: true; key?: never;
  maxPool?: never }` with `mapFn: (item: T, index: Accessor<number>) => O` -- so a
  literal `byValue: true` selects the plain-item mapFn type and the door rejections
  are visible at the type level.

### Changed -- torture harness (no new tier files)

- `makeByValueMapFn` (plain-item fixture, build counter); T5 gains a by-value
  differential lane (same oracle, reference keys, duplicate-object + `-0`/`0`
  shapes, `parked === 0` and `poolGrowths` delta 0 asserted); T6 gains phase 4
  (warm reorder pool-flat + insert exact-`k`); T1 gains the door cases and the
  by-value degenerate/`-0`<->`0` pins; T7 gains a 4096-cycle by-value soak (leak
  size back to 0, post-dispose `{ 0, 0, peak }` per cycle); T9 gains controls (h)
  (park-and-rebind staleness caught by the differential) and (i) (a doorless
  variant caught by the door pin). `test/byvalue_test.mjs` adds 6 `node:test` cases.

## [1.2.0] -- 2026-09-05

Pool observability (M-04), purely additive: a mapped list gains a read surface.
No reconcile behaviour change of any kind -- the four reconcile branches, acquire's
reuse path and retire's park path get zero new bytes; every counter line lands on
the build path (`makeSlot`) and the teardown path (`disposeSlot`).

### Added -- `mapped.stats()` on both primitives

- `mapped.stats() -> { live, parked, highWater }` on **both** `mapArray` and
  `indexArray`. `live` = current slot count (`= mapped().length`); `parked` =
  free-list length; `highWater` = the all-time peak of `live + parked`. This is the
  scoped counter the roadmap's LIS bench needed (previously
  `Object.getOwnPropertyNames(mapped)` was `["dispose"]` only).
- **Allocation-free per read.** `stats()` returns ONE `Object.freeze`'d object per
  list, reused on every call; its getters read the current slot/pool lengths and a
  per-instance high-water counter. `stats() === stats()` (reference-stable),
  `Object.isFrozen(stats())` is true, `Object.keys` is `[live, parked, highWater]`.
  Gated: 10,000 `stats()` reads inside the T6 window show `poolGrowths` /
  `totalAllocations` deltas both **0**, `maxMajor 0`, `maxArrayBuffersGrowth 0`.
- **LIVE VIEW semantics.** The three fields change between reads *without* another
  `stats()` call -- destructure/snapshot for a point-in-time copy. Same discipline as
  the persistent `mapped()` output array.
- **`highWater` is historical.** It is the peak of `live + parked`, survives
  `dispose()` (which pins `{ 0, 0, <peak> }`, no throw), and is exactly the mark the
  "growth past the previous high-water allocates" non-claim is about -- now
  measurable. A replace-all (n old + n new keys in one `set`) genuinely coexists both
  generations, so `highWater` records the `prevN + n` transient (50 rows -> 50 all-new
  keys leaves `highWater` at 100), not the settled count.

### Changed -- torture harness (no new tier files)

- The validator's Pool line is upgraded from the C0 engine-ledger witness to the
  exact `stats()` line: `live === arr.length`, `parked <= effective maxPool`,
  `live + parked <= highWater`, and `highWater` monotone non-decreasing across
  `validate()` calls. The engine-ledger conservation check is **kept** as a second,
  independent witness. Deferred reviewer nit 13 (an explicit numeric `parked <= cap`)
  lands here. `maxPool: 0` remains falsy -> unset (unbounded); documented, not changed.
- Tiers extended in place (T0 stats laws, T1 degenerate + `maxPool:0` pin, T6 phase 3
  alloc-free reads + hand-computed exactness, T7 per-cycle conservation, T9 two new
  in-process controls), and a new `test/stats_test.mjs` (node:test).

## [1.1.1] -- 2026-09-05

Hygiene release: no behaviour change, no new API. The only `Map.js` change is
the version-header comment (the reconcile code is byte-identical to 1.1.0). This
session (C0) stands up the torture gate the suite mandates and makes the two
feature gaps visible as planned tiers.

### Added -- the mandated torture gate (`npm run torture`)

`test/torture.mjs` is the mandated `node --expose-gc` entry, proving the zero-GC
claims the suite way -- a `@zakkster/lite-leak` retention witness (T7) and a
`@zakkster/lite-gc-profiler` heap witness (T6) **over** the engine pool counters,
not the counters alone. Before this, every gate rode the engine's own
`poolGrowths` / `totalAllocations` on a `bench/torture/maparray-fuzzer.mjs`
registry configured `onCapacityExceeded:"grow"` -- which structurally cannot
report the pool growth it exists to catch (its own NOTE admits it). A pool-flat
gate on a "grow" registry is a green light over the exact property it protects.

- Tiers (the fixed T0..T9 namespace, sparse): **T0** metamorphic laws
  (oracle-equality, idempotence, survivor identity, dispose-to-base), **T1**
  degenerate inputs (edge keys, contained duplicates, empty/single, throwing
  `keyOf`, non-array source), **T5** differential fuzz descended from the bench
  fuzzer but on a **pre-grown `"throw"`** registry with the T1 shapes injected,
  **T6** the zero-alloc gate (`poolGrowths` / `totalAllocations` deltas both 0
  **and** the gc-profiler report passes, `stabilize:'deep'`,
  `maxArrayBuffersGrowth:0`; plus the structural floor a heap gate cannot make --
  a 1000-row rotate-by-1 writes exactly 1000 `idxSig.set`, an adjacent swap
  exactly 2, and `mapped()` is reference-stable), **T7** a 4096-cycle soak with
  the lite-leak witness draining to `size()==0`, **T9** controls.
- **T9 controls + `test/controls.mjs` walk driver.** Every gate ships a
  deliberately-broken variant that makes the suite exit non-zero for the right
  reason: a "grow" registry rejected by the fail-closed alloc guard (the M-02 trap
  made executable), a rebuild-instead-of-reuse allocation the counter catches, an
  identity-losing diff the Identity line catches (the non-vacuity control), a
  per-read array allocation the stability check catches, and an allocating loop the
  gc gate fails (`verdict === 'fail'`, never merely `!ok`). `npm run
  torture:controls` walks every armable tier armed alone.
- `test/` and `bench/` stay out of `files[]`; `npm pack --dry-run` proves it (7
  files in the tarball). New scripts: `torture`, `torture:controls`, `verify`
  (= `test` + `torture` + `torture:controls`), and `prepublishOnly` (= `verify`).

### Changed

- The `test:torture` script (the bench fuzzer) is renamed **`fuzz:bench`** so
  `torture` unambiguously names the mandated gate. The bench fuzzer itself is
  unchanged.
- The `test` script is scoped to `test/*_test.mjs` (was bare `node --test`):
  `node --test` auto-discovers every file under `test/`, which now includes the
  torture entry (it refuses to run without `--expose-gc`). The glob matches
  exactly the four legacy suites -- still 45 cases, unchanged.

### Decisions recorded

- **M-06 -- the peer stays `^1.6.0-preview.2`.** The registry has NO stable
  release `>= 1.6.0`: the latest stable is `1.5.0`, the `1.6.x` line ends at
  `1.6.0-preview.2`, and the rebuild line is at `1.9.0-preview.6`. lite-map is
  built on `createScope`, which does not exist before the `1.6.0` previews, so the
  pin cannot widen to any stable. Kept as-is; revisit when a stable `1.6.0` (or the
  `1.9` rebuild) ships.
- **A `VERSION` export is declined.** No consumer reads it, and adding one would be
  new public API surface in a hygiene release. The three-place version sync
  (`package.json`, the `Map.js` header, `llms.txt`) is unchanged.

### Planned tiers registered (non-failing)

The harness names what it will grow: **C1 (M-04)** upgrades T6/T7's Pool line from
the engine ledger to the exact `mapped.stats()` `{ live, parked, highWater }` line;
**C2 (M-03)** adds a `byValue` T5/T6 variant (moves stay pool-flat, only genuine
inserts pull); **C3 (M-01)** benches output-move cost against T6's index-signal
floor (a rotate already writes exactly the genuinely-moved set -- the LIS milestone
is met at the reactive layer).

### Dev dependencies (dev-only; `Map.js` keeps zero runtime deps)

- `@zakkster/lite-gc-profiler ^1.16.0`, `@zakkster/lite-leak ^1.10.0`.
- The dev `@zakkster/lite-signal` is pinned to `1.6.0-beta-1` (not the
  `1.6.0-preview.2` peer floor): every published `lite-leak` statically imports
  `getOwner` from lite-signal, which the `1.6.0-preview.2` build does not export,
  so the retention witness cannot import against it. `1.6.0-beta-1` is the closest
  registry build exporting BOTH `getOwner` and `createScope`; the 45-test suite
  passes byte-for-byte against it, so lite-map's behaviour is unchanged. The
  **published peer range is untouched** (`^1.6.0-preview.2`) -- this is a dev-tool
  concern only. Installs may need `--legacy-peer-deps` on the prerelease crossing.

### Verified

- `npm test` -- **45/45**, unchanged.
- `npm run torture` -- prints exactly `ok`, exit 0, under `--expose-gc`; refuses to
  run without it (fail closed, exit 1).
- `npm run torture:controls` -- prints exactly `ok`, exit 0; every armed control
  exits non-zero for its own reason, no `CONTROL-DEFEATED` on the walk.

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
