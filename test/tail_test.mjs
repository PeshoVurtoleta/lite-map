// Tail fast-path suite for @zakkster/lite-map 1.1.
//
// mapArray gained a position-aligned common-prefix scan that classifies the
// dominant real-world mutations -- append, pop, in-place value churn -- and
// handles them with O(delta) tail work, skipping the general keyed diff's
// byKey churn / scratch swap / full retire scan. These are correctness-
// preserving fast paths: they must produce EXACTLY the general path's result
// (the property + reconciliation tests in map_test.mjs already cross-check
// against a model; this file pins the tail behaviours and the 10k gate).
//
// Oracle: map_test.mjs's trackingMapFn -- each CREATED scope gets a unique sid,
// kept across reuse, so sid-stability distinguishes MOVE/reuse from rebuild.
//
// Run: node --expose-gc --test test/tail_test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { createMapper } from "../Map.js";

// Isolated, roomy registry: the 10k-gate list needs far more headroom than the
// default 1024-node cap, and isolation keeps node accounting clean per file.
// Source signals, consumer effects, mapper and stats all share this registry.
const R = createRegistry({ maxNodes: 262144, maxLinks: 1048576 });
const { mapArray } = createMapper(R);
const signal = R.signal;
const effect = R.effect;
const stats = R.stats;

let SID = 0;
function trackingMapFn(idxRuns) {
    return (itemAcc, idxAcc) => {
        const view = { item: itemAcc(), index: idxAcc(), sid: SID++ };
        effect(() => { view.item = itemAcc(); });
        effect(() => { view.index = idxAcc(); if (idxRuns) idxRuns.n++; });
        return view;
    };
}
const ids = (mapped) => mapped().map((v) => v.item.id);
const vals = (mapped) => mapped().map((v) => v.item.v);
const sids = (mapped) => mapped().map((v) => v.sid);
const row = (id, v) => ({ id, v });
const keyById = { key: (r) => r.id };

// -- Append fast-path --------------------------------------------------------

test("append: one row appended keeps every existing scope (sids stable), order correct", () => {
    const src = signal([row("a", 1), row("b", 2), row("c", 3)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    const before = sids(mapped);

    src.set([row("a", 1), row("b", 2), row("c", 3), row("d", 4)]);   // pure append
    assert.deepEqual(ids(mapped), ["a", "b", "c", "d"]);
    assert.deepEqual(sids(mapped).slice(0, 3), before, "prefix scopes untouched (append fast-path)");
    stop(); mapped.dispose();
});

test("append: multiple rows at once", () => {
    const src = signal([row("a", 1)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    const sidA = sids(mapped)[0];
    src.set([row("a", 1), row("b", 2), row("c", 3), row("d", 4)]);
    assert.deepEqual(ids(mapped), ["a", "b", "c", "d"]);
    assert.equal(sids(mapped)[0], sidA, "row a scope preserved");
    stop(); mapped.dispose();
});

test("append does NOT re-run any existing row's index effect (no spurious reindex)", () => {
    const idxRuns = { n: 0 };
    const src = signal([row("a", 1), row("b", 2), row("c", 3)]);
    const mapped = mapArray(src, trackingMapFn(idxRuns), keyById);
    const stop = effect(() => { void mapped(); });
    idxRuns.n = 0;                                   // reset after initial mounts
    src.set([row("a", 1), row("b", 2), row("c", 3), row("d", 4)]);
    // Only the NEW row d mounts one index effect; a/b/c keep index 0/1/2.
    assert.equal(idxRuns.n, 1, "only the appended row's index effect ran");
    stop(); mapped.dispose();
});

// -- Pop fast-path -----------------------------------------------------------

test("pop: tail row removed, survivors keep scopes (sids stable)", () => {
    const src = signal([row("a", 1), row("b", 2), row("c", 3)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    const before = sids(mapped);
    src.set([row("a", 1), row("b", 2)]);             // pure pop
    assert.deepEqual(ids(mapped), ["a", "b"]);
    assert.deepEqual(sids(mapped), before.slice(0, 2), "survivor scopes untouched (pop fast-path)");
    stop(); mapped.dispose();
});

test("pop: removing multiple tail rows", () => {
    const src = signal([row("a", 1), row("b", 2), row("c", 3), row("d", 4)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    src.set([row("a", 1)]);
    assert.deepEqual(ids(mapped), ["a"]);
    stop(); mapped.dispose();
});

test("pop to empty (clear via tail)", () => {
    const src = signal([row("a", 1), row("b", 2)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    src.set([]);
    assert.deepEqual(ids(mapped), []);
    stop(); mapped.dispose();
});

// -- Value-churn fast-path (same keys, same order) ---------------------------

test("value churn: same order, changed values update in place; scopes stable", () => {
    const src = signal([row("a", 1), row("b", 2), row("c", 3)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    const before = sids(mapped);
    src.set([row("a", 10), row("b", 2), row("c", 30)]);   // a,c change value; keys+order identical
    assert.deepEqual(vals(mapped), [10, 2, 30]);
    assert.deepEqual(sids(mapped), before, "no scope rebuilt on value churn");
    stop(); mapped.dispose();
});

test("value churn does not fire the structural output (o reference stable)", () => {
    // out only fires on a real structural change. A same-order value churn must
    // NOT re-run a consumer that reads the mapped array structurally.
    const src = signal([row("a", 1), row("b", 2)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    let structuralRuns = 0;
    const stop = effect(() => { mapped(); structuralRuns++; });
    structuralRuns = 0;
    src.set([row("a", 99), row("b", 2)]);            // value-only
    assert.equal(structuralRuns, 0, "value churn did not fire the structural signal");
    assert.equal(vals(mapped)[0], 99, "but the value still updated through itemSig");
    stop(); mapped.dispose();
});

// -- The 10k gate ------------------------------------------------------------

test("GATE: 10k push/pop cycles on a warm list are zero-GC (pool flat)", () => {
    const N = 500;
    const baseArr = [];
    for (let i = 0; i < N; i++) baseArr.push(row("k" + i, i));
    const src = signal(baseArr.slice());
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });

    // Warm the free-list: one push/pop so the appended scope is parked for reuse.
    src.set(baseArr.concat(row("tail", -1)));
    src.set(baseArr.slice());

    const base = stats();
    for (let i = 0; i < 10000; i++) {
        src.set(baseArr.concat(row("tail", i)));     // push one
        src.set(baseArr.slice());                    // pop it
    }
    const after = stats();
    assert.equal(after.poolGrowths - base.poolGrowths, 0, "no pool growth across 10k push/pop cycles");
    assert.equal(after.totalAllocations - base.totalAllocations, 0, "no node allocations across 10k cycles");
    assert.deepEqual(ids(mapped), baseArr.map((r) => r.id), "list is back to its base state");
    stop(); mapped.dispose();
});

test("GATE: append-one to a large list preserves ALL survivor scopes", () => {
    const N = 300;
    const arr = [];
    for (let i = 0; i < N; i++) arr.push(row("k" + i, i));
    const src = signal(arr.slice());
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    const before = sids(mapped);
    src.set(arr.concat(row("new", 999)));
    assert.deepEqual(sids(mapped).slice(0, N), before, "all N survivor scopes preserved on append");
    assert.equal(ids(mapped)[N], "new");
    stop(); mapped.dispose();
});

// -- Fall-through: non-tail shapes still use the (correct) general path -------

test("prepend falls through to general diff (correct, reindexes survivors)", () => {
    const src = signal([row("b", 2), row("c", 3)]);
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });
    const sidB = sids(mapped)[0];
    src.set([row("a", 1), row("b", 2), row("c", 3)]);   // prepend a
    assert.deepEqual(ids(mapped), ["a", "b", "c"]);
    assert.equal(sids(mapped)[1], sidB, "b survived the prepend (moved, not rebuilt)");
    stop(); mapped.dispose();
});

test("interleaved tail ops and reorders stay correct against a model", () => {
    const model = [row("a", 1), row("b", 2), row("c", 3)];
    const src = signal(model.slice());
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = effect(() => { void mapped(); });

    const steps = [
        [row("a", 1), row("b", 2), row("c", 3), row("d", 4)],   // append (fast)
        [row("d", 4), row("a", 1), row("b", 2), row("c", 3)],   // rotate (general)
        [row("d", 4), row("a", 1), row("b", 2)],                // pop (fast)
        [row("d", 40), row("a", 1), row("b", 2)],               // value churn (fast)
        [row("a", 1), row("d", 40), row("b", 2)],               // swap (general)
    ];
    for (const s of steps) {
        src.set(s.slice());
        assert.deepEqual(ids(mapped), s.map((r) => r.id), "ids match after step");
        assert.deepEqual(vals(mapped), s.map((r) => r.v), "values match after step");
    }
    stop(); mapped.dispose();
});
