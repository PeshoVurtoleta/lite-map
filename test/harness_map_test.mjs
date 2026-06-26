// Property / edge harness for @zakkster/lite-map.
//
// map_test.mjs pins specific scenarios; keyed list reconciliation is the
// canonical property-testing target -- diff algorithms break on permutations no
// hand-written case happens to hit. This file drives RANDOM, uniqueness-
// preserving mutation sequences against a plain-array model and asserts the two
// guarantees the library exists to provide:
//
//   1. CORRECTNESS  -- mapped() always equals the model (ids + values, in order).
//   2. SCOPE REUSE  -- any key present before AND after a single mutation keeps
//                      its scope (sid stable): survivors MOVE, never rebuild.
//   3. ZERO-GC      -- bounded random churn allocates no nodes / grows no pool
//                      after warmup (the whole point of the free-list).
// plus edge cases: duplicate keys, pure permutations, clear/replace-all,
// single<->empty, and indexArray length+value churn.
//
// Modeled on map_test.mjs's trackingMapFn/sids oracle and DEFAULT registry
// throughout (no createRegistry -> no cross-registry tracking pitfalls).
//
// NOTE: requires lite-signal >=1.6.0-preview.0 (createScope); run once that is
// available. Syntax-validated only here -- not executed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, stats, dispose } from "@zakkster/lite-signal";
import { mapArray, indexArray } from "../Map.js";

// Deterministic PRNG (mulberry32) -- reproducible from the seed.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The map_test.mjs oracle: each CREATED scope gets a unique sid, kept across
// reuse, so sid-stability detects move-vs-rebuild. item/index are tracked into a
// stable view object.
let SID = 0;
function trackingMapFn() {
    return (itemAcc, idx) => {
        const idxIsAccessor = typeof idx === "function";
        const view = { item: itemAcc(), index: idxIsAccessor ? idx() : idx, sid: SID++ };
        effect(() => { view.item = itemAcc(); });
        if (idxIsAccessor) effect(() => { view.index = idx(); });
        return view;
    };
}
const items = (mapped) => mapped().map((v) => v.item);
const ids = (mapped) => mapped().map((v) => v.item.id);
const vals = (mapped) => mapped().map((v) => v.item.v);
const viewByKey = (mapped) => { const m = new Map(); for (const v of mapped()) m.set(v.item.id, v); return m; };

// ---------------------------------------------------------------------------
// 1. CORRECTNESS + SURVIVOR SCOPE-STABILITY under random churn
// ---------------------------------------------------------------------------
test("harness/property: mapArray output matches model; survivors keep their scope (no rebuild)", () => {
    const POOL = [];
    for (let i = 0; i < 16; i++) POOL.push("k" + i);

    for (const seed of [1, 7, 42, 1337, 0xBEEF]) {
        const rand = mulberry32(seed);
        let ver = 0;
        const used = new Set();
        let model = [];
        for (let i = 0; i < 5; i++) { const id = POOL[i]; used.add(id); model.push({ id, v: ver++ }); }

        const src = signal(model.map((o) => o));
        const mapped = mapArray(src, trackingMapFn(), { key: (it) => it.id });
        assert.deepEqual(ids(mapped), model.map((o) => o.id), `seed ${seed}: initial ids`);
        let prev = viewByKey(mapped);

        for (let step = 0; step < 500; step++) {
            const r = rand();
            const n = model.length;
            if (r < 0.20 && used.size < POOL.length) {            // insert an unused key
                const avail = POOL.filter((k) => !used.has(k));
                const id = avail[(rand() * avail.length) | 0];
                used.add(id);
                model.splice((rand() * (n + 1)) | 0, 0, { id, v: ver++ });
            } else if (r < 0.38 && n > 0) {                       // remove
                const idx = (rand() * n) | 0;
                used.delete(model[idx].id);
                model.splice(idx, 1);
            } else if (r < 0.54 && n >= 2) {                      // move
                const from = (rand() * n) | 0;
                const to = (rand() * n) | 0;
                const [it] = model.splice(from, 1);
                model.splice(to, 0, it);
            } else if (r < 0.66) {                                // reverse
                model.reverse();
            } else if (r < 0.78 && n >= 2) {                      // rotate left by k
                const k = 1 + ((rand() * (n - 1)) | 0);
                model = model.slice(k).concat(model.slice(0, k));
            } else if (r < 0.88 && n >= 2) {                      // swap two positions
                const i = (rand() * n) | 0, j = (rand() * n) | 0;
                const t = model[i]; model[i] = model[j]; model[j] = t;
            } else if (r < 0.97 && n > 0) {                       // value-replace (same key, new object)
                const idx = (rand() * n) | 0;
                model[idx] = { id: model[idx].id, v: ver++ };
            } else {                                              // clear (rare)
                for (const o of model) used.delete(o.id);
                model = [];
            }

            src.set(model.map((o) => o));

            assert.deepEqual(ids(mapped), model.map((o) => o.id), `seed ${seed} step ${step}: ids diverged`);
            assert.deepEqual(vals(mapped), model.map((o) => o.v), `seed ${seed} step ${step}: values diverged`);

            const cur = viewByKey(mapped);
            for (const [key, view] of cur) {
                if (prev.has(key)) {
                    assert.equal(view.sid, prev.get(key).sid,
                        `seed ${seed} step ${step}: survivor "${key}" was rebuilt (sid changed) instead of moved`);
                }
            }
            prev = cur;
        }
        mapped.dispose();
        dispose(src);
    }
});

// ---------------------------------------------------------------------------
// 2. ZERO-GC under bounded random churn
// ---------------------------------------------------------------------------
test("harness/property: bounded random churn is zero-GC after warmup", () => {
    const POOL = [];
    for (let i = 0; i < 12; i++) POOL.push("z" + i);
    const rand = mulberry32(99);
    let ver = 0;
    const used = new Set();
    let model = [];

    const src = signal([]);
    const mapped = mapArray(src, trackingMapFn(), { key: (it) => it.id });
    const stop = effect(() => { void mapped().length; });   // a live consumer

    // length stays in [6,12]; keys come from the fixed 12-pool so we never grow
    // past the warmed high-water mark (growth past it is documented to allocate).
    const churn = () => {
        const r = rand();
        const n = model.length;
        if (r < 0.40) {                                  // structural: random-walk length within [6,12]
            const grow = n <= 6 ? true : n >= 12 ? false : rand() < 0.5;
            if (grow && used.size < POOL.length) {
                const avail = POOL.filter((k) => !used.has(k));
                const id = avail[(rand() * avail.length) | 0];
                used.add(id);
                model.splice((rand() * (n + 1)) | 0, 0, { id, v: ver++ });
            } else if (!grow && n > 0) {
                const idx = (rand() * n) | 0; used.delete(model[idx].id); model.splice(idx, 1);
            }
        } else if (r < 0.70 && n >= 2) {                 // reverse
            model.reverse();
        } else if (r < 0.85 && n >= 2) {                 // swap
            const i = (rand() * n) | 0, j = (rand() * n) | 0; const t = model[i]; model[i] = model[j]; model[j] = t;
        } else if (n > 0) {                              // value-replace
            const idx = (rand() * n) | 0; model[idx] = { id: model[idx].id, v: ver++ };
        }
        src.set(model.map((o) => o));
    };

    // reach high-water (all 12 present at once) so the pool is fully populated,
    // then run the churn to settle into steady state BEFORE measuring.
    for (const k of POOL) { used.add(k); model.push({ id: k, v: ver++ }); }
    src.set(model.map((o) => o));
    for (let i = 0; i < 300; i++) churn();

    const base = stats();
    for (let i = 0; i < 4000; i++) churn();
    const after = stats();

    assert.equal(after.poolGrowths - base.poolGrowths, 0, "bounded random churn grew the pool");
    assert.equal(after.totalAllocations - base.totalAllocations, 0,
        "bounded random churn allocated nodes (moves set signals; inserts must reuse parked scopes)");

    stop(); mapped.dispose(); dispose(src);
});

// ---------------------------------------------------------------------------
// 3. EDGE: duplicate keys -- correct output, no leak (documented as inefficient)
// ---------------------------------------------------------------------------
test("harness/edge: duplicate keys render in order and dispose leaves no leak", () => {
    const base = stats();
    const A = { id: "x", v: 1 }, B = { id: "x", v: 2 }, C = { id: "y", v: 3 };
    const src = signal([A, C]);
    const mapped = mapArray(src, trackingMapFn(), { key: (it) => it.id });
    assert.deepEqual(ids(mapped), ["x", "y"]);

    src.set([A, B, C]);                          // two items share key "x"
    assert.deepEqual(ids(mapped), ["x", "x", "y"], "both duplicate-keyed items render, in order");
    assert.deepEqual(vals(mapped), [1, 2, 3], "each position shows its own item, not a collision");

    src.set([C]);                                // drop both dups
    assert.deepEqual(ids(mapped), ["y"]);

    mapped.dispose();
    dispose(src);
    assert.equal(stats().activeNodes, base.activeNodes,
        "every scope (including the extra dup-key scope) was torn down -- no leak");
});

// ---------------------------------------------------------------------------
// 4. EDGE: pure permutations move every survivor, never rebuild
// ---------------------------------------------------------------------------
test("harness/edge: reverse / rotate / swap move every survivor (all sids stable)", () => {
    const mk = (id) => ({ id, v: 0 });
    const order = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")];
    const src = signal(order.slice());
    const mapped = mapArray(src, trackingMapFn(), { key: (it) => it.id });
    const sidOf = () => { const m = {}; for (const v of mapped()) m[v.item.id] = v.sid; return m; };
    const s0 = sidOf();

    src.set(order.slice().reverse());
    assert.deepEqual(ids(mapped), ["e", "d", "c", "b", "a"]);
    assert.deepEqual(sidOf(), s0, "reverse kept every scope");

    src.set(order.slice());
    src.set(order.slice(2).concat(order.slice(0, 2)));      // rotate left 2
    assert.deepEqual(ids(mapped), ["c", "d", "e", "a", "b"]);
    assert.deepEqual(sidOf(), s0, "rotate kept every scope");

    const sw = order.slice(); const t = sw[0]; sw[0] = sw[4]; sw[4] = t;    // swap ends
    src.set(sw);
    assert.deepEqual(ids(mapped), ["e", "b", "c", "d", "a"]);
    assert.deepEqual(sidOf(), s0, "swap kept every scope");

    mapped.dispose(); dispose(src);
});

// ---------------------------------------------------------------------------
// 5. EDGE: clear / replace-all-distinct / single<->empty
// ---------------------------------------------------------------------------
test("harness/edge: clear, replace-all-distinct, and single<->empty transitions", () => {
    const mk = (id) => ({ id, v: 0 });
    const src = signal([mk("a"), mk("b"), mk("c")]);
    const mapped = mapArray(src, trackingMapFn(), { key: (it) => it.id });
    assert.deepEqual(ids(mapped), ["a", "b", "c"]);

    src.set([]);                                  assert.deepEqual(ids(mapped), []);                    // clear
    src.set([mk("p"), mk("q")]);                  assert.deepEqual(ids(mapped), ["p", "q"]);            // grow from empty
    src.set([mk("x"), mk("y"), mk("z")]);         assert.deepEqual(ids(mapped), ["x", "y", "z"]);       // replace-all-distinct
    src.set([mk("x")]);                           assert.deepEqual(ids(mapped), ["x"]);                 // shrink to single
    src.set([]);                                  assert.deepEqual(ids(mapped), []);                    // to empty
    src.set([mk("solo")]);                        assert.deepEqual(ids(mapped), ["solo"]);              // empty to single

    mapped.dispose(); dispose(src);
});

// ---------------------------------------------------------------------------
// 6. EDGE/PROPERTY: indexArray output correctness across length + value churn
// ---------------------------------------------------------------------------
test("harness/property: indexArray output matches model across random length + value churn", () => {
    const rand = mulberry32(2024);
    const src = signal([0, 1, 2]);
    const mapped = indexArray(src, trackingMapFn());
    let model = [0, 1, 2];
    let tick = 100;

    for (let step = 0; step < 400; step++) {
        const r = rand();
        const n = model.length;
        if (r < 0.35) {                               // grow
            const add = 1 + ((rand() * 3) | 0);
            for (let i = 0; i < add; i++) model.push(tick++);
        } else if (r < 0.65 && n > 0) {               // shrink
            const rm = 1 + ((rand() * Math.min(3, n)) | 0);
            model.length = Math.max(0, n - rm);
        } else if (n > 0) {                           // value churn in place
            const reps = 1 + ((rand() * n) | 0);
            for (let i = 0; i < reps; i++) model[(rand() * n) | 0] = tick++;
        }
        src.set(model.slice());
        assert.deepEqual(items(mapped), model, `step ${step}: indexArray output diverged from model`);
    }
    mapped.dispose(); dispose(src);
});
