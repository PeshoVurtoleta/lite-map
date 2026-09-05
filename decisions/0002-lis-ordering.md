# 0002 -- LIS ordering for mapArray: the output-move floor (M-01)

Status: DECIDED 2026-09-05 (C3 planning; written AFTER the bench and BEFORE any
Map.js edit, mirroring 0001's timing). Choice: B -- DOCUMENT AS MET. No LIS pass
ships; Map.js is byte-identical to 3da8c37 (v1.3.0).
Evidence: BRIEF.md (C3) THE DECISION + RESOLVED SCOPE FACTS 6-9, SESSION PLAN
section 3 (falsifiable criteria A-1..A-3), and the bench bench/lis-probe.mjs run
on the settled engine lite-signal 1.6.0-beta-1 (stable 1.6.0 not yet on the
registry at session time -- see M-06). Amendments, if implementation contradicts
a clause, are recorded here with a date -- never silently.

The milestone M-01 names LIS -- "the reconciler should touch the output in the
theoretical n - LIS minimum of positions on a reorder". This decision records
that (i) the index-signal layer is ALREADY at its move-minimal floor (gated since
C0/C1), (ii) the ONLY remaining cost is redundant plain stores into one
persistent output array, and (iii) that cost does not clear the bar to justify an
unconditional guard in the hot body. Each clause below follows from the measured
table.

## (a) The measured table (bench/lis-probe.mjs, verbatim)

    lite-map LIS probe -- seed=0x9e3779b9 lite-signal=1.6.0-beta-1 n=1000
    shape            n     moved(1)  oStores(2)  LIS   n-LIS(3)  redundant  path
    rotate-by-1      1000  1000      1000        999   1         0          general
    reverse          1000  1000      1000        1     999       0          general
    shuffle          1000  998       1000        59    941       2          general
    adjacent-swap    1000  2         1000        999   1         998        general
    moves-25pct      1000  929       1000        774   226       71         general

    A-1 (redundant/n >= 0.50): 1/5 shapes -- A-1 FAILS (< 3)

Column provenance:
- moved(1): idxSig.set writes today, measured LIVE via an index-effect rerun
  counter reset immediately before each set() (the t6-alloc.mjs:186 discipline).
  This is the M-01 index-signal floor -- already gated at t6-alloc.mjs:185-201.
- oStores(2): DERIVED, not counted. The rewrite loop at Map.js:370 is
  unconditional over 0..n and reached only when `changed` is true, so on the
  general path stores == n. The bench proves the general/changed path ran
  (prevN == n AND exactly one out flush AND moved > 0) and multiplies; a row it
  cannot classify would print path=UNCLASSIFIED and exit non-zero. All five rows
  classified general.
- n-LIS(3): the classic move floor, computed bench-side (patience/tails, allocs
  freely -- the bench gates nothing).
- redundant: n - moved, the positional-array store floor (see clause c).

## (b) The index-signal layer is already move-minimal (M-01's reactive half)

moved(1) == the genuinely-moved rows on every shape: rotate-by-1 = 1000 (every
index shifts), adjacent-swap = 2 (one pair), reverse = 1000. idxSig.set fires at
Map.js:353 EXACTLY when `existing.index !== i`, so a survivor that keeps its index
writes nothing. This floor is not a claim here -- it is pinned by
t6-alloc.mjs:185-201 (a 1000-row rotate writes exactly 1000; an adjacent swap
writes exactly 2). The reactive layer M-01 cares about is at its minimum today.

## (c) BRIEF fact 9 -- the recoverable cost is invisible to every gate this package owns

For an UNMOVED row, o[i] already holds slots[i].view before the rewrite loop
runs, so the store at Map.js:370 (`o[i] = slots[i].view`) is IDEMPOTENT: it
writes the value the slot already holds. The only recoverable work an LIS pass
could remove is these redundant PLAIN STORES into ONE persistent array. That is
no allocation, no pool pull, no engine node -- it is invisible to poolGrowths,
totalAllocations, maxMajor, maxArrayBuffersGrowth, lite-leak retention, and
stats(). Consequence, stated so it cannot be misread later: NO zero-GC gate can
ever move on this number, so a green zero-GC gate after an LIS pass is NOT
evidence the pass helped, and no zero-GC gate can be cited FOR option A. The only
honest witness is a wall-clock measurement (criterion A-2).

## (d) n - LIS is the WRONG floor here; n - redundant is the right one (planner correction)

The milestone names n - LIS, the minimum number of MOVE operations for an
insertion-ordered container. But o is POSITIONALLY indexed
(o[i] = slots[i].view, Map.js:370), not a linked/insertion structure, so its
achievable store floor is n - redundant, where redundant == n - moved -- NOT
n - LIS. The two quantities diverge sharply and in BOTH directions:
- rotate-by-1: n - LIS == 1 (one element out of order) but redundant == 0 (every
  row genuinely moved, so no store is idempotent). The classic floor says "1
  move"; the positional array must still rewrite all 1000 slots.
- adjacent-swap: n - LIS == 1 and redundant == 998 -- the array floor is far
  lower than the move floor, but the absolute cost (2 non-redundant stores) is
  already trivial.
- moves-25pct: n - LIS == 226 while redundant == 71 -- again different numbers.
The milestone's premise ("LIS reduces output rewrites") does not hold for a
positionally-indexed persistent array. An LIS pass minimizes MOVE operations; it
does not minimize positional stores. What an LIS pass could recover here is
exactly `redundant` stores, no more.

## (e) The criteria (SESSION PLAN section 3) applied mechanically

CHOOSE A only if ALL THREE hold; CHOOSE B if ANY fails.

- A-1 (recoverable share) -- `redundant / n >= 0.50` on >= 3 of the 5 shapes.
  MEASURED: passes on 1/5 (adjacent-swap, 998/1000). rotate-by-1 = 0.000,
  reverse = 0.000, shuffle = 0.002, moves-25pct = 0.071. A-1 FAILS (1 < 3).
- A-2 (demonstrated bottleneck, wall-clock) -- NOT MEASURED, and per the T8 note
  it need not be: A-2 is only required for shapes that pass A-1, and A-1 already
  fails on 4 of 5 shapes. There is no >= 3-shape set on which a wall-clock
  prototype was owed.
- A-3 (zero-GC feasibility) -- not reached; the choice is already fixed by A-1.

## (f) The choice: B -- document as met

DECISION: B. The deciding criterion is A-1 (recoverable share): the redundant
share clears 0.50 on only ONE shape (adjacent-swap), and that shape's absolute
recoverable cost is 998 idempotent stores whose non-redundant remainder is just 2
-- a shape whose cost is already trivial. The shapes that motivate LIS in the
literature (rotate, reverse, shuffle) are exactly the shapes where nearly every
row's index genuinely changes, so redundant sits at or near 0 and there is
essentially nothing for a guard to skip. An LIS/guard rewrite is unconditional
bytes in the hot body (shared hot-path law 5: a guard that never fires still
costs its bytes) -- one load plus one compare per row replacing one store -- paid
on every reconcile of every shape to save redundant stores that only exist on the
one shape whose cost is already negligible. On arithmetic, not preference, the
choice is B. M-01 is closed as ALREADY MET: the index-signal layer is at its
n-moved floor (clause b, gated), and output-move minimization for a positional
array is a n - redundant concern whose measured recoverable share does not meet
the bar (clause e). Any consumer that needs fewer positional stores can diff the
output itself; lite-map will not carry an unconditional guard for it.

Map.js is UNTOUCHED under this decision (git diff 3da8c37 -- Map.js is empty).
The byValue family (Map.js:421-end) is likewise byte-identical, and was never in
scope (NON-GOALS: insert-dominated, reorders already pool-flat).
