# 0001 -- by-value mapArray: the reuse contract

Status: DECIDED 2026-09-05 (C2 planning; before coding, per ROADMAP C2).
Evidence: BRIEF.md (C2) RESOLVED SCOPE FACTS 1-14, verified against v1.2.0
(git dfba786). Amendments, if implementation contradicts a clause, are
recorded here with a date -- never silently.

`{ byValue: true }` changes the reuse contract of mapArray: mapFn receives
`item` as a PLAIN VALUE (`(item: T, index: () => number) => O`), so a view
captures the item in its closure and no signal exists to redirect it. Every
clause below follows from that single fact.

## (a) Moves

A MOVE (same item, new index) still rides `idxSig.set` with NO mapFn re-run.
Only inserts lose reuse: survivors keep their scope, their view, and their
identity across any reorder. (Fact 3: the accessor rebind at Map.js:259-260
is the only mechanism byValue loses.)

## (b) maxPool

REJECTED AT THE DOOR -- `byValue + maxPool` throws at creation. A parked
byValue slot's view is baked to its old item and can never be re-bound for a
different one, so the free-list structurally cannot serve byValue inserts,
and the roadmap NON-GOAL forbids inventing a new reuse mechanism to pretend
otherwise. A cap on a pool that cannot be reused is a silent no-op; the law
says fail closed. Consequences: byValue removals dispose IMMEDIATELY (the
retire variant is disposeSlot), and `parked === 0` is a byValue invariant
(stats() reads { live, 0, highWater }).

## (c) indexArray

NO -- mapArray only. indexArray's CHANGING dimension is the value accessor;
a by-value indexArray would rebuild a slot on every value churn, the exact
rebuild churn this package exists to remove.

## (d) key

REJECTED AT THE DOOR -- `byValue + key` throws at creation. With a custom
keyOf an item can change under a stable key; accessor mode absorbs that via
`itemSig.set` (Map.js:346), but a byValue view would silently hold the stale
plain item. byValue keys by REFERENCE identity: the item IS the key
(SameValueZero equivalence class -- the prefix scan's `===` and the byKey
Map agree; `-0 <-> 0` is therefore NOT an item change in byValue mode, a
documented seam pinned by a T1 case). An item change is by construction an
insert + retire, never staleness.

## (e) The cost, pinned positively

A byValue insert re-runs mapFn EXACTLY ONCE for the new row and allocates a
fixed engine-node count k for a known fixture mapFn -- calibrated once
outside the measured window, asserted `==` on every measured insert, under a
small hard ceiling. The gate asserts the cost EXISTS and is EXACT, so both a
false "byValue is zero-GC" claim and hidden extra allocation fail. Reorders
on a warm byValue list stay pool-flat (clause a); that pair of gates is the
whole cost story, stated at the call site in README, llms.txt, and Map.d.ts.

## Door summary (fail closed, ASCII, did-you-mean)

Throw at creation on: `byValue + key`, `byValue + maxPool`, and a truthy
`byValue` that is not exactly `true`. `byValue: false` / absent selects the
accessor mode unchanged. The accessor family gains exactly one dispatch line;
its reconcile bodies are byte-untouched (BRIEF A5).
