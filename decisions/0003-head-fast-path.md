# 0003 -- head fast-paths for mapArray: the constant-factor recoverable (M-05)

Status: DECIDED 2026-09-05 (C4; written AFTER the bench and BEFORE any Map.js
edit, mirroring 0001/0002's timing). Choice: A -- SHIP a head fast-path, CONDITIONAL
on H-2 (semantics byte-identical over the T5 corpus), H-3 (zero-alloc at stable n
under the pre-grown T6 head window), and R3 (the SHIPPED implementation re-measured
>= 0.25 share at BOTH sizes). A miss on ANY condition reverts Map.js byte-identical
to 0f92d70 (v1.4.0) and a dated amendment here records B. Amendments are never silent.
AMENDED SAME DAY: R3 missed on the shipped path -- the FINAL CHOICE IS B. The
paragraph above is the decision-time record; see the dated Amendment at the end.

Evidence: BRIEF.md (C4) THE DECISION + RESOLVED SCOPE FACTS 6-10, SESSION PLAN +
COORDINATOR AMENDMENT (H-1 two-stage, recoverable-share formula), and the bench
bench/head-probe.mjs run on the settled engine lite-signal 1.6.0-beta-1 (stable
1.6.0 not yet on the registry at session time -- see M-06). The milestone M-05
names head fast-paths -- the 1.1 completion the tail fast-paths (append/pop/value-
churn, Map.js:302-343) left open, which deliberately fall a head shape through to
the general keyed diff (Map.js:293-295 comment).

## (a) The measured tables (bench/head-probe.mjs, verbatim)

Canonical decision-time run (settled engine 1.6.0-beta-1; the run coder #1 audited
for confounds -- see clause (e)):

    lite-map head-probe -- lite-signal=1.6.0-beta-1
    ANALYTIC (two-run byte-identical)
    shape       n     prevN  idxSets  oStores  byKeyGets  retireScan  path
    prepend     101   100    101      101      101        100         general
    shift       100   101    100      100      100        101         general
    head-cycle  100   100    100      100      100        100         general
    prepend     1001  1000   1001     1001     1001       1000        general
    shift       1000  1001   1000     1000     1000       1001        general
    head-cycle  1000  1000   1000     1000     1000       1000        general

    TIMED (machine-local, excluded from determinism check)
    node=v26.3.1 platform=darwin/arm64 warm=300 reps=7 cycles=600
    size   realUs    spread            twinUs    shareUpper
    100    7.22      6.79..8.07        3.03      0.581
    1000   66.42     65.25..68.98      37.12     0.441
    H-1 stage 1: shareUpper n=100=0.581 n=1000=0.441 | shareWorst n=100=0.509 n=1000=0.436 | bar=0.250
    stage 2 required (shareUpper >= 0.25 at BOTH sizes, gap > spread)

    H-1 STAGE 2 (prototype: FAITHFUL bench-side head fast-path)
    size   realUs    protoUs   shareProto
    100    7.78      4.54      0.417
    1000   72.43     48.23     0.334
    H-1 CLEARS (stage 2) -> option A candidate; H-2/H-3 gate the in-repo path

Re-run at session start (coder #2, same engine, same machine; wall-clock varies,
the verdict does not): shareUpper n=100=0.505 n=1000=0.438; STAGE 2 shareProto
n=100=0.387 n=1000=0.480; H-1 CLEARS (stage 2). The two runs agree on every
ANALYTIC column and on the verdict; only the timed medians drift within spread.

## (b) The inherent floor -- what NO head fast-path can remove

Every survivor's index shifts on a head mutation. A prepend of d rows moves every
existing row from index i to i+d; a shift of d drops the head and moves every
survivor from i to i-d; a head-cycle does both. There is no rotation, no aligned
prefix -- the prefix scan (Map.js:298-300) concludes p === 0 on the first compare
because arr[0] carries a changed key. So a head fast-path MUST still pay, per cycle:

  - idxSig.set on EVERY survivor whose index changed (fan-out into that survivor's
    one index effect) -- the analytic idxSets column == n for head-cycle, prevN..n
    for prepend/shift. This is the M-01 move-minimal floor (0002 clause b); it is
    inherent, gated at t6-alloc.mjs:185-201, and NOT removable.
  - the full o[] rewrite: o[i] = slots[i].view for i in 0..n (Map.js:370). Because
    the head moved, o[0..n) is genuinely stale -- unlike the tail paths, NO suffix
    of o is idempotent, so the rewrite is inherent (contrast 0002 clause c, where
    unmoved survivors made the store idempotent).
  - the O(n) in-place slots re-seat (a memmove: shift every survivor one or d
    positions), one acquire of each new head (or retire() of each dropped head /
    trimmed tail, so the free-list still applies), and one out.set.

This is exactly the general path's cost MINUS the recoverable bookkeeping in (c).
The BRIEF fact-6/7 fall-through comment at Map.js:293-295 names prepend as the
deliberate general-path case; that comment's premise (idxSig fan-out + o[] rewrite
are inherent to a head mutation) is what makes the floor un-lowerable here.

## (c) BRIEF fact-9 -- the recoverable is INVISIBLE to every zero-GC gate

The recoverable work a head fast-path removes from the general path is:
  - per-row byKey.get x n (Map.js:350): the general diff looks up every row's key
    to find its survivor. A head path that verifies alignment positionally needs
    at most d + one O(n) key-only scan, not n Map lookups on the hot re-seat.
  - the retire scan x prevN (Map.js:362-365): the general diff walks every prior
    slot checking s.seen !== epoch even when nothing but the head retires. A head
    path retires exactly the d dropped heads (or the trimmed tail) directly.
  - the scratch swap + per-row scratch[i] store bookkeeping (Map.js:355,367).

Every one of these is a plain Map lookup, a plain array read, or a plain store.
NONE allocates, pulls from the pool, or creates an engine node. So the recoverable
is invisible to poolGrowths, totalAllocations, maxMajor, maxArrayBuffersGrowth,
lite-leak retention, and stats() -- exactly as 0002 clause c found for the LIS
redundant stores. Stated so it cannot be misread later: NO zero-GC gate can be
cited FOR this fast path. A green torture run after the edit proves the fast path
did not BREAK the zero-alloc contract (H-3) and did not change SEMANTICS (H-2); it
is NOT evidence the fast path is FASTER. The only honest witness of the win is
wall-clock (H-1 / R3): the medians in (a) and the R3 re-measure are RECORDED
EVIDENCE, not gates. Gates prove semantics and zero-alloc only.

## (d) The structural asymmetry vs the tail fast-paths (why 1.4x, not 15x)

The tail fast-paths (Map.js:302-343) won ~15x because append/pop have TWO
properties a head mutation lacks: (i) O(delta) inherent work -- only the appended
/popped tail rows touch a slot, the prefix survivors keep both their index and
their o[] entry, so idxSig.set fires ZERO times and the o[] rewrite touches only
[prevN,n) or nothing; (ii) zero index shifts. A head mutation has NEITHER: every
survivor's index shifts (O(n) idxSig.set) and the whole o[] is stale (O(n)
rewrite). The head fast-path therefore cannot approach the tail's 15x -- its win
is the constant-factor diff bookkeeping in (c) over an operation whose reactive
cost (the fan-out) is inherent and dominant. The bench measures that constant
factor at ~1.4x (shareProto 0.33-0.48: real ~1.5-1.9x proto). This asymmetry is
the whole reason M-05 needed a bench before a byte: the roadmap's own lean was
"bench first; if it is in the noise, record the decision and slip". It is not in
the noise -- but it is a constant factor, not an order.

## (e) H-1..H-3 applied mechanically, with the confound audit (the honesty record)

H-1 (recoverable share >= 0.25 at BOTH sizes, outside spread), two-stage per the
COORDINATOR AMENDMENT:
  - STAGE 1 (twin lower bound): shareUpper n=100=0.581, n=1000=0.441; shareWorst
    (spread-adjusted) n=100=0.509, n=1000=0.436. Both >= 0.25, no straddle. The
    twin OMITS byKey.get / retire-scan / scratch-swap, so it UNDER-states any real
    fast path and the share is an OVER-estimate -- the error points toward A, so a
    PASS here is necessary, not sufficient. Stage 2 required.
  - STAGE 2 (faithful prototype): shareProto n=100=0.417, n=1000=0.334. Both
    >= 0.25, no straddle, robust across runs (n=1000 0.33-0.48, n=100 0.39-0.46 on
    the two session runs). H-1 CLEARS.
  Confound audit (coder #1, the fail-closed-toward-B honesty record, verbatim
  intent):
    1. A first cut inflated realUs to ~92us by timing the consumer's O(n) array
       construction INSIDE the timer. Fixed: the real cycle times ONLY src.set;
       inputs are pre-materialised outside the timer (bench:289-305). Cross-check
       reconcile-only == 66.6us, matches BRIEF fact-8.
    2. The twin/proto consumer effect was made byte-for-byte as heavy as the real
       per-row index effect (accessor indirection + view.index write), or the
       fan-out would be under-weighted and the recoverable over-stated.
    3. The AMENDMENT's minimal proto (twin + a bare key-scan) is a LOOSE
       overestimate: micro-isolation showed byKey.get x n is only ~5us at n=1000,
       so a proto that skips it flatters A. It was REPLACED with a FAITHFUL bench-
       side head fast-path doing EVERY op a shipped path pays -- keyOf detection
       scan, byKey.delete/set for the retired tail AND the new head, itemSig.set on
       the new head, per-survivor idxSig.set re-seat, in-place memmove, o[] rewrite,
       out.set. Even this strict proto clears. This is R3 done early on a bench-side
       twin; the in-repo R3 re-measure (below) closes it on the SHIPPED code.
    4. H-2 caveat the TIMING proto cannot measure (bench:201-209): the proto
       identifies survivors POSITIONALLY and skips the per-row byKey.get that
       disambiguates duplicate keys (Map.js:350) and enforces retire ownership
       (Map.js:277). A positional-only path is NOT semantics byte-identical, so the
       shipped path keeps byKey as the owner of record: it VERIFIES alignment with
       a pure key scan and manages byKey.delete/set exactly as the general path
       would, ending the reconcile in the identical byKey state. H-2 is the gate
       that closes this (the T5 corpus differential + the T9 armed control).

H-2 (semantics byte-identical over the T5 corpus): GATED, not asserted here. The
three head shapes are injected into the t5-fuzz stream and oracle-checked every
step (Order + Identity + Index) against the plain-array reference; the byKey map
must end each reconcile in the state the general path would produce.

H-3 (zero-alloc at stable n): GATED by a new t6-alloc head window -- a pre-grown
throw registry, warm head-cycle loop at stable n, poolGrowths/totalAllocations
deltas == 0, maxArrayBuffersGrowth == 0, and the exact analytic idxSig count
pinned with ==.

## (f) The choice: A -- SHIP, conditional

DECISION: A. H-1 clears both stages at both sizes outside spread; the recoverable
is a real constant-factor win (clause d) on the ecosystem's most common non-tail
mutation. A ships ONLY if all three conditions below hold at implementation time;
a miss on ANY ONE reverts Map.js byte-identical to 0f92d70 and this file is
amended to B with the shipped numbers (never silently):

  - H-2: semantics byte-identical over the T5 corpus (the three head shapes in the
    fuzz stream, oracle-clean every step; the T9 armed head control fails when the
    survivor idxSig.set is skipped or a survivor is handed a fresh scope).
  - H-3: zero-alloc at stable n under the pre-grown T6 head window (both engine
    deltas 0, maxArrayBuffersGrowth 0, the ==-pinned idxSig count).
  - R3: the SHIPPED Map.js head path, re-measured by bench/head-probe.mjs against a
    near-head general-path PROXY, shows share_shipped >= 0.25 at BOTH sizes. A miss
    voids H-1's arithmetic for the real code -> revert to B.

Law 5 (a guard that never fires still costs its bytes) binds the shape: the pre-
gates that decline non-head shapes are O(1) (one byKey.get on arr[0]'s key, one
arithmetic length check), NOT a scan -- rotate/reverse/shuffle/mid-insert reach the
general diff having paid one Map lookup, not an O(n) probe. Only a genuine head
candidate pays the O(n) alignment verification, and a failed verification falls
through to the general diff unchanged. The general diff and the tail fast-paths
stay byte-identical.

## Amendment -- 2026-09-05 (same day, post-implementation): R3 MISSED; the choice is B

The conditional in (f) fired, exactly as written. What happened, in order:

1. The head fast-path WAS implemented in Map.js in the law-5 shape (f) requires
   (O(1) pre-gates on arr[0]'s key + the O(n) alignment verification; the three
   shapes; general diff and tail paths byte-identical), together with its gates
   (t6 head window, t5 corpus head shapes, t9 armed head control). The full
   torture gate ran green on it -- which, per clause (c), proved only H-2 and
   H-3, never the win.
2. R3 then re-measured the SHIPPED path against the near-head general-path
   proxy (head-cycle + one adjacent mid-list swap, declined by the pre-gates).
   The shipped share did NOT robustly clear 0.25 at BOTH sizes outside the
   spread: it fell below the bar at n=1000. Root cause, recorded in the bench's
   own NOTE at the stage-2 proto: the faithful proto was still OPTIMISTIC --
   it identified survivors positionally and skipped the per-row byKey
   verification that a CORRECT path cannot skip (duplicate-key disambiguation,
   Map.js:350 convention, and retire ownership, Map.js:277). Keeping byKey the
   owner of record costs on the order of the byKey traffic micro-isolated in
   clause (e).1-3 (~5 us at n=1000, ~0.07-0.08 of share), which consumes the
   n=1000 stage-2 margin (0.334 - 0.25 = 0.084). The proto's number was a
   timing upper bound for a unique-key input only; the honest path missed.
3. Per (f), the miss on R3 reverts everything: Map.js, Map.d.ts, and the three
   torture tiers are byte-identical to 0f92d70 again (verified: git diff
   0f92d70 -- Map.js Map.d.ts test/ is empty); the bench remains, restored to
   its decision-time form with the R3 outcome recorded in its header and in
   the stage-2 NOTE. The R3-form bench (fast-path anchors + proxy + verdict
   mechanics) was a working artifact of the reverted implementation; its
   anchors bind to source that no longer exists, so it is not kept as a repo
   file -- its method is recorded here and in the restored bench's comments.
   The exact shipped-path medians were not preserved past the revert; the
   qualitative verdict (below 0.25 at n=1000, cause above) was written into
   the restored bench header at revert time and stands as the record.

FINAL CHOICE: B -- M-05 closes WITHOUT a head fast-path. The measured story,
end to end: the recoverable bookkeeping is real (H-1 stage 1 and even the
strict stage-2 proto clear 0.25), but the margin at n=1000 is thinner than the
correctness tax a shipped path must pay (byKey as owner of record), and the
fail-closed rule -- an unproven win does not buy hot-body bytes -- resolves the
straddle to B. The general path stays the only reorder path; the tail
fast-paths remain the only fast paths. Any future revisit starts from this
amendment's root cause, not from H-1.