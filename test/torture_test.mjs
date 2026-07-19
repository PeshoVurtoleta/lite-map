/**
 * Torture / adversarial regression suite for @zakkster/lite-map.
 *
 * Each test pins a defect found during the v1.1.0 prepublish review, or a limit
 * that is deliberately NOT fixed and must not drift silently.
 *
 * Notes for anyone extending this file:
 *
 *  - IDENTITY IS THE CONTRACT. A keyed list exists so that a row which merely
 *    moved keeps its scope -- its DOM node, focus, scroll offset, animation
 *    state. Order and length being right is necessary but not sufficient; the
 *    shipped fuzzer already covers those. The oracle here is "same key => same
 *    view object", which is what actually breaks in the wild.
 *
 *  - IDENTITY IS ONLY DEFINED FOR A KEY APPEARING ONCE. The README requires
 *    unique keys. The duplicate-key tests therefore do not assert that a
 *    duplicate keeps its scope (it cannot -- which of the two?); they assert
 *    that a duplicate never costs some OTHER, unique key its scope, and that
 *    the damage does not outlive the duplicate.
 *
 *  - NODE-COUNT TESTS INSTALL A FIXED CEILING and restore a roomy one after.
 *    A "grow" registry turns a hard leak into an invisible bleed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, dispose, createRegistry, setDefaultRegistry, stats } from "@zakkster/lite-signal";
import { mapArray, indexArray } from "../Map.js";

/* -- helpers ---------------------------------------------------------------- */

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ROOMY = { maxNodes: 1 << 18, maxLinks: 1 << 20, onCapacityExceeded: "grow" };
function inRegistry(config, fn) {
    setDefaultRegistry(createRegistry(config));
    try { return fn(); } finally { setDefaultRegistry(createRegistry(ROOMY)); }
}
setDefaultRegistry(createRegistry(ROOMY));

const mk = (id) => ({ id });
const byId = { key: (i) => i.id };

/* -- 1. Duplicate keys must not corrupt the survivor index ------------------ */

test("a duplicate episode does not cost a unique key its scope", () => {
    // byKey used to be overwritten by the duplicate's slot. When the duplicate
    // was then removed, retire() deleted the entry (it matched the duplicate),
    // leaving the ORIGINAL slot live but unreachable -- so the next reorder
    // handed a survivor a brand new scope. The damage outlived the misuse.
    const a = mk("a"), b = mk("b");
    const src = signal([a, b]);
    const views = mapArray(src, (item) => ({ id: () => item().id }), byId);
    const stop = effect(() => { views(); });

    const aView = views()[0];
    src.set([a, b, a]);              // duplicate appended (pure-append fast path)
    src.set([a, b]);                 // duplicate removed  (pure-pop fast path)
    assert.equal(views()[0], aView, "'a' lost its scope while the list was still [a,b]");

    src.set([b, a]);                 // reorder -> general keyed diff needs byKey
    assert.equal(views()[1], aView, "'a' lost its scope on the reorder after a duplicate episode");
    assert.equal(views().map((v) => v.id()).join(","), "b,a");
    stop(); views.dispose();
});

// GUARD, not a regression pin: this one passes on v1.1.0 too. The corruption is
// reachable through it in principle (a re-keyed pooled slot can shadow another
// key's byKey entry), but no short deterministic sequence was found that trips
// it -- the randomised test below is what actually catches the class. Kept
// because it is cheap and states the invariant plainly.
test("GUARD: a duplicate of one key does not disturb a different key", () => {
    const rows = ["k0", "k1", "k2"].map(mk);
    const src = signal(rows);
    const views = mapArray(src, (item) => ({ id: () => item().id }), byId);
    const stop = effect(() => { views(); });
    const k0View = views()[0];

    src.set([rows[2], rows[0], rows[2], rows[1]]);   // k2 duplicated, k0 innocent
    src.set([rows[0], rows[1], rows[2]]);            // back to unique
    const idx = views().findIndex((v) => v.id() === "k0");
    assert.equal(views()[idx], k0View, "an unrelated key lost its scope because another key was duplicated");
    stop(); views.dispose();
});

// GUARD, as above: passes on v1.1.0. States the pooled-slot invariant directly.
test("GUARD: a pooled slot never leaves a stale byKey entry under its old key", () => {
    // acquire() re-keys a slot pulled from the free-list. If retire() had
    // declined to clear that slot's previous entry (because a duplicate owned
    // it), the entry would survive pointing at a slot that no longer holds it.
    const rows = Array.from({ length: 6 }, (_, i) => mk("k" + i));
    const src = signal(rows.slice(0, 4));
    const views = mapArray(src, (item) => ({ id: () => item().id }), byId);
    const stop = effect(() => { views(); });
    src.set([rows[0], rows[1], rows[0]]);        // duplicate k0
    src.set([rows[4], rows[5]]);                 // everything retires, pool re-keyed
    src.set([rows[0], rows[1]]);                 // k0/k1 come back from the pool
    assert.equal(views().map((v) => v.id()).join(","), "k0,k1", "projection wrong after pool re-key");
    const k0 = views()[0];
    src.set([rows[1], rows[0]]);                 // reorder must find k0 through byKey
    assert.equal(views()[1], k0, "k0 lost its scope -- stale byKey entry");
    stop(); views.dispose();
});

/* -- 2. Identity under randomised editing ----------------------------------- */

function identityFuzz(seed, { allowDup }) {
    const rnd = mulberry32(seed);
    const keyspace = 6;
    const rows = Array.from({ length: keyspace }, (_, i) => mk("k" + i));
    const src = signal([rows[0], rows[1]]);
    const views = mapArray(src, (item) => ({ id: () => item().id }), byId);
    const stop = effect(() => { views(); });

    const viewOf = new Map();
    const failures = [];
    const check = (label) => {
        const arr = src.peek(), out = views();
        if (out.length !== arr.length) { failures.push(`${label}: length ${out.length} != ${arr.length}`); return; }
        for (let i = 0; i < arr.length; i++) {
            if (out[i].id() !== arr[i].id) failures.push(`${label}: slot ${i} shows ${out[i].id()} want ${arr[i].id}`);
        }
        const mult = new Map();
        for (let i = 0; i < arr.length; i++) mult.set(arr[i].id, (mult.get(arr[i].id) || 0) + 1);
        const now = new Map();
        for (let i = 0; i < arr.length; i++) if (mult.get(arr[i].id) === 1) now.set(arr[i].id, out[i]);
        for (const [k, v] of now) {
            const prev = viewOf.get(k);
            if (prev !== undefined && prev !== v) failures.push(`${label}: unique key ${k} LOST its scope`);
        }
        viewOf.clear();
        for (const [k, v] of now) viewOf.set(k, v);
    };

    check("init");
    for (let o = 0; o < 120 && failures.length === 0; o++) {
        const cur = src.peek().slice();
        const roll = rnd();
        if (roll < 0.25 && cur.length < keyspace + (allowDup ? 3 : 0)) {
            const cand = rows[(rnd() * rows.length) | 0];
            if (allowDup || !cur.includes(cand)) cur.splice((rnd() * (cur.length + 1)) | 0, 0, cand);
        } else if (roll < 0.45 && cur.length > 0) cur.splice((rnd() * cur.length) | 0, 1);
        else if (roll < 0.70 && cur.length > 1) {
            const i = (rnd() * cur.length) | 0, j = (rnd() * cur.length) | 0;
            const t = cur[i]; cur[i] = cur[j]; cur[j] = t;
        } else if (roll < 0.85) cur.reverse();
        else if (cur.length > 0 && allowDup) cur.push(cur[0]);
        src.set(cur);
        check(`op${o}(${cur.map((r) => r.id).join("|")})`);
    }
    stop(); views.dispose();
    return failures;
}

test("300 seeds of unique-key editing preserve every scope", () => {
    for (let seed = 1; seed <= 300; seed++) {
        const f = identityFuzz(seed, { allowDup: false });
        assert.equal(f.length, 0, `seed ${seed}: ${f.slice(0, 2).join(" | ")}`);
    }
});

// THE differential for the duplicate-key defect: 125/300 on v1.1.0, 300/300
// patched. Seeds fail on sequences like [k4|k0|k5|k3|k4|k0] -> [k4|k0|k5|k3|k4],
// where k0 becomes unique again and finds its scope gone.
test("300 seeds WITH duplicates still preserve every unique key's scope", () => {
    for (let seed = 1; seed <= 300; seed++) {
        const f = identityFuzz(seed, { allowDup: true });
        assert.equal(f.length, 0, `seed ${seed}: ${f.slice(0, 2).join(" | ")}`);
    }
});

/* -- 3. Pool accounting ----------------------------------------------------- */

const SHAPES = {
    "append/pop": (i, rows) => (i % 2 ? rows.slice(0, 50) : rows.slice(0, 51)),
    "rotate": (i, rows) => rows.slice(i % 50).concat(rows.slice(0, i % 50)),
    "prepend/shift": (i, rows) => (i % 2 ? rows.slice(1, 51) : rows.slice(0, 51)),
    "duplicate-key list": (i, rows) => (i % 2 ? [rows[0], rows[1], rows[0]] : [rows[1], rows[0], rows[0]]),
};

for (const [name, shape] of Object.entries(SHAPES)) {
    test(`node ledger stays flat under ${name} churn`, () => {
        inRegistry({ maxNodes: 8192 }, () => {
            const rows = Array.from({ length: 51 }, (_, k) => mk("k" + k));
            const src = signal(rows.slice(0, 50));
            const views = mapArray(src, (item) => ({ id: () => item().id }), byId);
            const stop = effect(() => { const v = views(); for (let k = 0; k < v.length; k++) v[k].id(); });
            let settled = 0;
            for (let i = 0; i < 3000; i++) {
                src.set(shape(i, rows));
                if (i === 199) settled = stats().activeNodes;
            }
            const end = stats().activeNodes;
            assert.equal(end, settled, `${name}: ledger drifted ${settled} -> ${end}`);
            stop(); views.dispose();
        });
    });
}

test("dispose() returns every node both mappers took", () => {
    inRegistry({ maxNodes: 8192 }, () => {
        for (const make of [mapArray, indexArray]) {
            const base = stats().activeNodes;
            const src = signal(Array.from({ length: 20 }, (_, i) => mk("k" + i)));
            const v = make(src, (item) => ({ id: () => item() }), byId);
            const stop = effect(() => { v(); });
            src.set(src.peek().slice(0, 10));      // leave slots in BOTH live set and pool
            stop();
            v.dispose();
            assert.equal(stats().activeNodes - base, 1, "residual beyond the caller's own source signal");
            dispose(src);   // the source signal is the caller's; drop it so the next lap starts clean
        }
    });
});

test("maxPool caps retained scopes instead of hoarding them", () => {
    inRegistry({ maxNodes: 8192 }, () => {
        const src = signal(Array.from({ length: 40 }, (_, i) => mk("k" + i)));
        const v = mapArray(src, (item) => ({ id: () => item().id }), { key: (i) => i.id, maxPool: 5 });
        const stop = effect(() => { v(); });
        const peak = stats().activeNodes;
        src.set([]);
        const parked = stats().activeNodes;
        assert.ok(parked < peak / 2, `maxPool ignored: ${peak} -> ${parked}`);
        src.set(Array.from({ length: 40 }, (_, i) => mk("k" + i)));
        assert.equal(v().length, 40, "regrow after a capped pool produced the wrong length");
        stop(); v.dispose();
    });
});

test("indexArray tail oscillation rebuilds nothing", () => {
    let built = 0;
    const src = signal([1, 2, 3, 4, 5, 6, 7, 8]);
    const v = indexArray(src, (item) => { built++; return { v: () => item() }; });
    const stop = effect(() => { v(); });
    const afterFirst = built;
    for (let i = 0; i < 200; i++) src.set(Array.from({ length: i % 2 ? 3 : 8 }, (_, k) => k));
    assert.equal(built - afterFirst, 0, "tail oscillation pulled new scopes instead of reusing parked ones");
    stop(); v.dispose();
});

/* -- 4. Hostile inputs ------------------------------------------------------ */

test("edge-case key values reconcile correctly", () => {
    for (const keys of [[undefined, undefined], [null, null], [NaN, NaN], [-0, 0], [1, "1"]]) {
        const src = signal(keys.map((k, i) => ({ id: k, n: i })));
        const v = mapArray(src, (item) => ({ n: () => item().n }), byId);
        const stop = effect(() => { v(); });
        assert.equal(v().length, 2, `keys ${String(keys)}: wrong length`);
        src.set(src.peek().slice().reverse());
        assert.equal(v().length, 2, `keys ${String(keys)}: wrong length after reverse`);
        stop(); v.dispose();
    }
});

test("a throwing key extractor leaves the reconciler consistent", () => {
    let boom = false;
    const rows = ["a", "b", "c"].map(mk);
    const src = signal(rows.slice(0, 2));
    const v = mapArray(src, (item) => ({ id: () => item().id }), {
        key: (i) => { if (boom && i.id === "b") throw new Error("keyOf exploded"); return i.id; },
    });
    const stop = effect(() => { v(); });
    boom = true;
    assert.throws(() => src.set(rows), /keyOf exploded/);
    boom = false;
    src.set(rows.slice(0, 2));
    assert.equal(v().map((x) => x.id()).join(","), "a,b", "state corrupt after a keyOf throw");
    stop(); v.dispose();
});

/* -- 5. Documented limits -- pinned, NOT fixed ------------------------------- */

test("LIMIT: a parked scope keeps reacting to external signals", () => {
    // This is the sharp edge of the free-list design. A removed row's scope is
    // PARKED, not disposed -- which is what makes reuse allocation-free, but it
    // also means its mapFn effects stay subscribed. Any effect reading a signal
    // OTHER than item()/index() keeps running for rows that are no longer in the
    // list, with the stale item still bound. lite-signal has no pause primitive:
    // a scope is live or disposed, so this cannot be fixed inside lite-map
    // without giving up the reuse the package exists for.
    //
    // Mitigations for callers: keep mapFn effects derived from item()/index()
    // only, or cap `maxPool` so the parked population is bounded.
    const theme = signal("light");
    const painted = [];
    const src = signal([mk("r1"), mk("r2")]);
    const v = mapArray(src, (item) => {
        effect(() => { painted.push(item().id + ":" + theme()); });
        return {};
    }, byId);
    const stop = effect(() => { v(); });
    src.set([]);                     // both rows leave the list
    painted.length = 0;
    theme.set("dark");               // an unrelated, app-wide change
    assert.deepEqual(painted, ["r1:dark", "r2:dark"],
        "parked-scope reactivity changed -- update the docs deliberately");
    stop(); v.dispose();
});

test("LIMIT: parked reactivity costs the all-time high-water mark", () => {
    let runs = 0;
    const ext = signal(0);
    const src = signal(Array.from({ length: 2000 }, (_, i) => mk("k" + i)));
    const v = mapArray(src, () => { effect(() => { ext(); runs++; }); return {}; }, byId);
    const stop = effect(() => { v(); });
    src.set([]);
    runs = 0;
    ext.set(1);
    assert.equal(runs, 2000,
        "an EMPTY list still runs one effect per all-time row; if this changed, the pool semantics changed");
    stop(); v.dispose();
});

test("LIMIT: mapped() hands back the reconciler's own array", () => {
    // Documented ("ONE persistent array, mutated in place; do not retain"), but
    // nothing enforces it: a consumer mutating the result corrupts internal
    // state, because the fast paths only rewrite the slots they changed.
    const src = signal([mk("a"), mk("b"), mk("c")]);
    const v = mapArray(src, (item) => ({ id: () => item().id }), byId);
    const stop = effect(() => { v(); });
    assert.equal(v(), v(), "output array identity is stable across reads");
    const arr = v();
    arr.length = 0;                          // a consumer doing something ordinary
    src.set([mk("a")]);
    assert.equal(v()[0], undefined,
        "output-buffer aliasing changed -- if it is defended now, replace this pin");
    stop(); v.dispose();
});
