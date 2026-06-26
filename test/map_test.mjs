import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, stats, dispose } from "@zakkster/lite-signal";
import { mapArray, indexArray, createMapper } from "../Map.js";

// A mapFn that records each scope's reactive item/index into a stable view object.
// `sid` is assigned once per CREATED scope, so a reused scope keeps its sid -> we
// can detect zero-GC reuse by sid stability.
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
const sids = (mapped) => mapped().map((v) => v.sid);

test("indexArray: output reflects items in order; values update in place", () => {
    const src = signal([10, 20, 30]);
    const mapped = indexArray(src, trackingMapFn());
    assert.deepEqual(items(mapped), [10, 20, 30]);
    const before = sids(mapped);

    src.set([11, 20, 33]);                       // same length -> pure value churn
    assert.deepEqual(items(mapped), [11, 20, 33]);
    assert.deepEqual(sids(mapped), before, "stable length reuses every slot in place (no rebuild)");
    mapped.dispose();
});

test("indexArray: value churn at stable length is zero-GC", () => {
    const src = signal([0, 0, 0, 0]);
    const mapped = indexArray(src, trackingMapFn());
    let sink;
    const stop = effect(() => { sink = items(mapped); });    // a live consumer
    const base = stats();
    for (let i = 0; i < 20000; i++) src.set([i, i + 1, i + 2, i + 3]);
    const after = stats();
    assert.equal(after.poolGrowths - base.poolGrowths, 0, "no pool growth under 20k value updates");
    assert.equal(after.totalAllocations - base.totalAllocations, 0, "no node allocations under 20k value updates");
    assert.deepEqual(items(mapped), [19999, 20000, 20001, 20002], "views reflect the latest values");
    void sink; stop(); mapped.dispose();
});

test("indexArray: tail push/pop reuses parked slots (zero-GC oscillation)", () => {
    const src = signal([1, 2, 3]);
    const mapped = indexArray(src, trackingMapFn());
    const s3 = sids(mapped);                      // sids for the 3 slots
    src.set([1, 2]);                              // pop -> slot 2 parked
    src.set([1, 2, 9]);                           // push -> reuse parked slot at index 2
    assert.deepEqual(items(mapped), [1, 2, 9]);
    assert.equal(sids(mapped)[2], s3[2], "tail re-grow reused the same parked scope (index 2)");
    mapped.dispose();
});

test("mapArray: keyed output order; reorder MOVES survivors (no rebuild)", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const src = signal([a, b, c]);
    const mapped = mapArray(src, trackingMapFn());
    const sidA = sids(mapped)[0];
    assert.deepEqual(mapped().map((v) => v.item.id), ["a", "b", "c"]);

    src.set([c, a, b]);                            // reorder
    assert.deepEqual(mapped().map((v) => v.item.id), ["c", "a", "b"]);
    // 'a' kept its scope (same sid) and its index accessor updated to 1
    const va = mapped().find((v) => v.item.id === "a");
    assert.equal(va.sid, sidA, "survivor reused across reorder");
    assert.equal(va.index, 1, "reused scope's reactive index updated to its new position");
    mapped.dispose();
});

test("mapArray: remove parks a scope; a later insert REUSES it (zero-GC insert)", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const src = signal([a, b, c]);
    const mapped = mapArray(src, trackingMapFn());
    const sidB = mapped().find((v) => v.item.id === "b").sid;

    src.set([a, c]);                               // remove b -> its scope parked
    assert.deepEqual(mapped().map((v) => v.item.id), ["a", "c"]);

    const d = { id: "d" };
    src.set([a, c, d]);                            // insert d -> reuse b's parked scope
    const vd = mapped().find((v) => v.item.id === "d");
    assert.equal(vd.sid, sidB, "insert reused the parked scope rather than building a new one");
    assert.equal(vd.item.id, "d", "reused scope rebound to the new item");
    mapped.dispose();
});

test("mapArray: reconciliation correctness across append/prepend/remove/reorder/replace", () => {
    const mk = (id) => ({ id });
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(mk);
    const src = signal([a, b, c]);
    const mapped = mapArray(src, trackingMapFn());
    const ids = () => mapped().map((v) => v.item.id);

    src.set([a, b, c, d]);          assert.deepEqual(ids(), ["a", "b", "c", "d"]);   // append
    src.set([e, a, b, c, d]);       assert.deepEqual(ids(), ["e", "a", "b", "c", "d"]); // prepend
    src.set([e, a, c, d]);          assert.deepEqual(ids(), ["e", "a", "c", "d"]);   // remove middle (b)
    src.set([d, c, a, e]);          assert.deepEqual(ids(), ["d", "c", "a", "e"]);   // reorder
    src.set([mk("x"), mk("y")]);    assert.deepEqual(ids(), ["x", "y"]);             // replace all
    src.set([]);                    assert.deepEqual(ids(), []);                     // clear
    mapped.dispose();
});

test("mapArray: custom key refreshes a survivor's item under a stable key", () => {
    const src = signal([{ id: 1, v: "a" }, { id: 2, v: "b" }]);
    const mapped = mapArray(src, trackingMapFn(), { key: (it) => it.id });
    const sid1 = sids(mapped)[0];
    src.set([{ id: 1, v: "A" }, { id: 2, v: "b" }]);   // same keys, item #1 replaced
    assert.equal(sids(mapped)[0], sid1, "same key kept the scope");
    assert.equal(mapped()[0].item.v, "A", "scope rebound to the refreshed item");
    mapped.dispose();
});

test("mapArray: dispose() tears down every scope (stats return to baseline)", () => {
    const base = stats();
    const src = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const mapped = mapArray(src, () => { effect(() => {}); return {}; });   // effect is cascaded; no bare user signal to leak
    assert.ok(stats().activeNodes > base.activeNodes, "scopes allocated nodes");
    src.set([{ id: 1 }]);                          // park two
    mapped.dispose();
    dispose(src);
    assert.equal(stats().activeNodes, base.activeNodes, "all live + parked scopes disposed, plus the source");
});

test("mapArray: reorder + warm-pool insert/remove churn is zero-GC", () => {
    const objs = [];
    for (let i = 0; i < 8; i++) objs.push({ id: i });
    const src = signal(objs.slice());
    const mapped = mapArray(src, trackingMapFn());
    let sink;
    const stop = effect(() => { sink = mapped().length; });

    // warm: run the churn a few times so the pool is populated and everything is hot
    let next = 100;
    for (let w = 0; w < 5; w++) {
        const arr = src().slice();
        arr.reverse();                              // reorder
        arr.pop();                                  // remove one -> parks a scope
        arr.push({ id: next++ });                   // insert one -> reuses a parked scope
        src.set(arr);
    }
    const base = stats();
    for (let i = 0; i < 5000; i++) {
        const arr = src().slice();
        arr.reverse();
        arr.pop();
        arr.push({ id: next++ });
        src.set(arr);
    }
    const after = stats();
    assert.equal(after.poolGrowths - base.poolGrowths, 0, "no pool growth under reorder + warm-pool churn");
    assert.equal(after.totalAllocations - base.totalAllocations, 0, "no node allocations: moves set signals, inserts reuse parked scopes");
    assert.equal(sink, 8);
    stop(); mapped.dispose();
});

test("createMapper binds to an explicit registry instance", async () => {
    const mod = await import("@zakkster/lite-signal");
    // default-registry helpers exist; createMapper accepts the same surface.
    const m = createMapper(mod);
    assert.equal(typeof m.mapArray, "function");
    assert.equal(typeof m.indexArray, "function");
    const src = signal([1, 2]);
    const mapped = m.indexArray(src, (it, i) => ({ get: it, i }));
    assert.equal(mapped().length, 2);
    mapped.dispose();
});
