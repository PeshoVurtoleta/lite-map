import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect } from "@zakkster/lite-signal";
import { mapArray, indexArray } from "../Map.js";

// stats() is the C1 read surface: a reused, Object.freeze'd LIVE VIEW carrying
// { live, parked, highWater }. These cases pin the shape, the frozenness, the
// reference stability, and -- with a hand-kept ledger -- the exact counts across
// append / pop / reorder / middle insert-remove (mapArray), grow / shrink
// (indexArray), maxPool overflow, the maxPool:0 quirk, and post-dispose.

// The source uses equals:()=>false so setting any array (even a same-shaped one)
// always reconciles; every case still passes a fresh array for clarity.
const src = (v) => signal(v, { equals: () => false });
const mk = (id) => ({ id });

// Assert the whole { live, parked, highWater } tuple in one place, plus the
// conservation invariant live + parked === total against the test's OWN ledger
// (expected builds minus expected disposals -- never read from the module).
function expectStats(mapped, live, parked, highWater, total, label) {
    const s = mapped.stats();
    assert.equal(s.live, live, label + ": live");
    assert.equal(s.parked, parked, label + ": parked");
    assert.equal(s.highWater, highWater, label + ": highWater");
    assert.equal(s.live + s.parked, total, label + ": live+parked === total (conservation)");
}

test("stats: shape, frozenness, reference stability", () => {
    const mapped = mapArray(src([mk("a"), mk("b")]), (it) => ({ v: it() }));

    const s1 = mapped.stats();
    const s2 = mapped.stats();
    assert.equal(s1, s2, "stats() returns the SAME reference every call");
    assert.ok(Object.isFrozen(s1), "the stats object is frozen");
    assert.equal(typeof s1.live, "number");
    assert.equal(typeof s1.parked, "number");
    assert.equal(typeof s1.highWater, "number");
    assert.equal(Object.keys(s1).join(","), "live,parked,highWater", "key order is fixed");

    // A frozen object rejects mutation (silent in sloppy mode; assert it stuck).
    try { s1.live = 999; } catch (_) { /* strict-mode throw is also fine */ }
    assert.equal(mapped.stats().live, 2, "frozen fields cannot be overwritten");

    mapped.dispose();
});

test("stats: is a LIVE VIEW -- fields change with no second stats() call", () => {
    const source = src([mk("a"), mk("b"), mk("c")]);
    const mapped = mapArray(source, (it) => ({ v: it() }));
    const s = mapped.stats();
    assert.equal(s.live, 3);
    source.set([mk("a")]);                  // shrink to 1 -- keys differ, all rebuilt
    assert.equal(s.live, 1, "the captured object reflects the new live without a re-read");
    mapped.dispose();
});

test("stats: exact counts across append / pop / reorder / middle insert-remove", () => {
    const a = mk("a"), b = mk("b"), c = mk("c"), d = mk("d"), e = mk("e");
    const source = src([a, b, c]);
    const mapped = mapArray(source, (it) => ({ v: it() }), { key: (x) => x.id });
    let total = 3;                           // ledger: 3 built at init
    expectStats(mapped, 3, 0, 3, total, "init [a,b,c]");

    source.set([a, b, c, d]);               // append d -> build 1 (pool empty)
    total += 1;
    expectStats(mapped, 4, 0, 4, total, "append d");

    source.set([a, b, c]);                  // pop d -> park (unbounded pool)
    expectStats(mapped, 3, 1, 4, total, "pop d");

    source.set([a, b, c, e]);               // append e -> REUSE parked slot (no build)
    expectStats(mapped, 4, 0, 4, total, "append e reuses pool");

    source.set([e, b, c, a]);               // reorder -> all survivors, no build/park
    expectStats(mapped, 4, 0, 4, total, "reorder");

    source.set([e, c, a]);                  // middle remove b -> park
    expectStats(mapped, 3, 1, 4, total, "middle remove b");

    source.set([e, c, d, a]);               // middle insert d -> REUSE parked slot
    expectStats(mapped, 4, 0, 4, total, "middle insert d reuses pool");

    mapped.dispose();
});

test("stats: exact counts across indexArray grow / shrink", () => {
    const source = src([10, 20, 30]);
    const mapped = indexArray(source, (it) => ({ v: it() }));
    let total = 3;
    expectStats(mapped, 3, 0, 3, total, "init 3");

    source.set([10, 20, 30, 40]);           // grow -> build 1
    total += 1;
    expectStats(mapped, 4, 0, 4, total, "grow to 4");

    source.set([10, 20, 30, 40, 50]);       // grow -> build 1
    total += 1;
    expectStats(mapped, 5, 0, 5, total, "grow to 5");

    source.set([10, 20, 30]);               // shrink -> park 2 tail slots (unbounded)
    expectStats(mapped, 3, 2, 5, total, "shrink to 3");

    source.set([10, 20, 30, 40]);           // grow -> reuse index-matched parked slot
    expectStats(mapped, 4, 1, 5, total, "regrow to 4 reuses pool");

    source.set([10, 20, 30, 40, 50]);       // grow -> reuse the other parked slot
    expectStats(mapped, 5, 0, 5, total, "regrow to 5 reuses pool");

    mapped.dispose();
});

test("stats: maxPool overflow disposes past the cap (total-- proven)", () => {
    const rows = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(mk("k" + i)); return a; };
    const six = rows(6);
    const source = src(six.slice());
    const mapped = mapArray(source, (it) => ({ v: it() }), { key: (x) => x.id, maxPool: 2 });
    let total = 6;                           // 6 built
    expectStats(mapped, 6, 0, 6, total, "grow to 6");

    source.set([]);                          // drop all: cap 2 parked, 4 disposeSlot'd
    total -= 4;                              // ledger: 4 disposals
    expectStats(mapped, 0, 2, 6, total, "drop to 0 (cap 2)");

    source.set(rows(6));                     // regrow all-new: reuse 2 + build 4
    total += 4;
    expectStats(mapped, 6, 0, 6, total, "regrow to 6 -- highWater flat (not 10)");

    mapped.dispose();
});

test("stats: replace-all captures the prevN+n transient high-water", () => {
    const A = []; for (let i = 0; i < 50; i++) A.push(mk("a" + i));
    const B = []; for (let i = 0; i < 50; i++) B.push(mk("b" + i));
    const source = src(A.slice());
    const mapped = mapArray(source, (it) => ({ v: it() }), { key: (x) => x.id });
    expectStats(mapped, 50, 0, 50, 50, "50 rows");

    source.set(B.slice());                   // 50 ALL-NEW keys in ONE set
    // The old 50 are still live while the new 50 are acquired -> total climbs to
    // 100 before the old ones retire; that transient IS the honest high-water.
    expectStats(mapped, 50, 50, 100, 100, "replace-all -> highWater 100");

    source.set(B.slice(0, 5));               // shrink; highWater must not lower
    assert.equal(mapped.stats().highWater, 100, "shrink does not lower highWater");
    source.set(B.slice(0, 20));              // regrow from warm pool; still 100
    assert.equal(mapped.stats().highWater, 100, "regrow does not lower highWater");

    mapped.dispose();
});

test("stats: maxPool:0 is falsy -> unbounded (documented quirk, fact 7)", () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(mk("m" + i));
    const source = src(rows.slice());
    const mapped = mapArray(source, (it) => ({ v: it() }), { key: (x) => x.id, maxPool: 0 });
    expectStats(mapped, 5, 0, 5, 5, "5 rows");
    source.set([]);                          // 0 is falsy -> Infinity: all 5 stay parked
    const s = mapped.stats();
    assert.equal(s.parked, 5, "maxPool:0 does NOT cap the pool (treated as unset)");
    assert.equal(s.live, 0);
    assert.equal(s.highWater, 5);
    mapped.dispose();
});

test("stats: post-dispose pins { 0, 0, historical } and does not throw", () => {
    const mapped = mapArray(src([mk("a"), mk("b"), mk("c")]), (it) => ({ v: it() }));
    const peak = mapped.stats().highWater;
    assert.equal(peak, 3);
    const s = mapped.stats();
    mapped.dispose();
    // Same reference; live/parked zeroed; highWater historical; no throw.
    assert.equal(mapped.stats(), s, "stats() reference is stable across dispose");
    assert.equal(s.live, 0, "post-dispose live is 0");
    assert.equal(s.parked, 0, "post-dispose parked is 0");
    assert.equal(s.highWater, peak, "post-dispose highWater is historical");
});

test("stats: a live consumer does not perturb the counts", () => {
    // The internal driver reconciles on its own; a second consumer must not change
    // the pool population. This guards against a getter that reads the wrong binding.
    const source = src([mk("a"), mk("b")]);
    const mapped = mapArray(source, (it) => ({ v: it() }), { key: (x) => x.id });
    let sink;
    const stop = effect(() => { sink = mapped().length; });
    source.set([mk("a"), mk("b"), mk("c")]);
    expectStats(mapped, 3, 0, 3, 3, "with a live consumer");
    void sink; stop(); mapped.dispose();
});
