/**
 * @zakkster/lite-map -- by-value mapArray ([1.3]) unit tests.
 *
 * The opt-in contract: mapFn receives the PLAIN item and an index accessor; a
 * MOVE rides the index signal with no mapFn re-run, an INSERT re-runs mapFn once
 * (there is no scope reuse), removals dispose immediately (parked === 0), keys are
 * by reference identity (SameValueZero). The door throws on byValue+key,
 * byValue+maxPool, and a truthy-non-true byValue. The accessor mode is unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal as sig, effect as eff } from "@zakkster/lite-signal";
import { mapArray as mapArr } from "../Map.js";

// A build counter incremented once per CREATED scope (per mapFn run). Flat across a
// reorder proves moves never re-run mapFn; +1 per insert proves the pull cost.
let BUILDS = 0;
function byValueMapFn() {
    return (item, idx) => {
        assert.equal(typeof idx, "function", "byValue index must be an accessor");
        const view = { item, index: idx(), sid: BUILDS++ };
        eff(() => { view.index = idx(); });
        return view;
    };
}
const items = (mapped) => mapped().map((v) => v.item);
const sids = (mapped) => mapped().map((v) => v.sid);

test("byValue door: key / maxPool / truthy-non-true throw; byValue:true is accepted", () => {
    const src = sig([]);
    assert.throws(() => mapArr(src, byValueMapFn(), { byValue: true, key: (x) => x }),
        /byValue[\s\S]*key|key[\s\S]*byValue/, "byValue + key must throw");
    assert.throws(() => mapArr(src, byValueMapFn(), { byValue: true, maxPool: 8 }),
        /byValue[\s\S]*maxPool|maxPool[\s\S]*byValue/, "byValue + maxPool must throw");
    assert.throws(() => mapArr(src, byValueMapFn(), { byValue: 1 }),
        /byValue/, "a truthy non-true byValue must throw (no silent ignore)");
    const s2 = sig([{ id: "z" }]);
    const m = mapArr(s2, byValueMapFn(), { byValue: true });     // must NOT throw
    assert.equal(m().length, 1);
    m.dispose();
});

test("byValue mapFn receives the PLAIN item (not an accessor)", () => {
    const a = { id: "a" }, b = { id: "b" };
    const src = sig([a, b]);
    const seen = [];
    const m = mapArr(src, (item, idx) => { seen.push(item); return { item, index: idx() }; }, { byValue: true });
    assert.deepEqual(seen, [a, b], "mapFn saw the plain objects, in order");
    assert.equal(typeof seen[0], "object", "item is a plain value, not a function");
    assert.deepEqual(items(m), [a, b]);
    m.dispose();
});

test("byValue MOVE does not re-run mapFn and keeps identity (sid stable)", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const src = sig([a, b, c]);
    const m = mapArr(src, byValueMapFn(), { byValue: true });
    const before = sids(m);
    const builds0 = BUILDS;

    src.set([c, a, b]);                                          // pure reorder
    assert.deepEqual(items(m), [c, a, b]);
    assert.equal(BUILDS, builds0, "a reorder must not re-run mapFn (build counter flat)");
    // Each surviving reference keeps its exact view (sid): a->a, b->b, c->c.
    const now = sids(m);
    assert.equal(now[0], before[2], "c kept its scope across the move");
    assert.equal(now[1], before[0], "a kept its scope across the move");
    assert.equal(now[2], before[1], "b kept its scope across the move");
    m.dispose();
});

test("byValue INSERT re-runs mapFn exactly once per new row; removal disposes (parked 0)", () => {
    const a = { id: "a" }, b = { id: "b" };
    const src = sig([a]);
    const m = mapArr(src, byValueMapFn(), { byValue: true });
    assert.equal(m.stats().parked, 0);

    let builds0 = BUILDS;
    src.set([a, b]);                                            // one genuine insert
    assert.equal(BUILDS - builds0, 1, "an insert re-runs mapFn exactly once");
    assert.equal(m.stats().live, 2);
    assert.equal(m.stats().parked, 0, "byValue never parks (no free-list)");

    src.set([a]);                                              // removal disposes immediately
    assert.equal(m.stats().parked, 0, "a removal parks nothing -- it disposes");

    builds0 = BUILDS;
    src.set([a, { id: "b2" }]);                                // insert after a retire: still builds
    assert.equal(BUILDS - builds0, 1, "an insert after a retire still re-runs mapFn (no reuse)");
    m.dispose();
});

test("byValue keys by reference: same ref is a contained duplicate; -0<->0 is not a change", () => {
    const a = { id: "x" }, c = { id: "y" };
    const src = sig([a]);
    const m = mapArr(src, byValueMapFn(), { byValue: true });
    const aView = m()[0];

    src.set([a, a, c]);                                        // same ref twice: contained dup
    assert.equal(m().length, 3);
    assert.equal(m()[0], aView, "the duplicate did not evict the owner's view");
    assert.equal(m.stats().parked, 0);
    src.set([a, c]);                                          // drop the dup; owner stays
    assert.equal(m()[0], aView, "owner kept its view after the dup left");
    m.dispose();

    // -0 and 0 are the same key (SameValueZero): no rebuild, view keeps the rep.
    const zsrc = sig([-0]);
    const zm = mapArr(zsrc, byValueMapFn(), { byValue: true });
    const v0 = zm()[0];
    zsrc.set([0]);
    assert.equal(zm()[0], v0, "-0 -> 0 did not rebuild the slot");
    assert.ok(Object.is(zm()[0].item, -0), "view retained the SameValueZero representative");
    zm.dispose();
});

test("byValue stats() interplay: { live, 0, highWater }, replace-all transient, post-dispose peak", () => {
    const mk = (n, tag) => { const a = []; for (let i = 0; i < n; i++) a.push({ id: tag + i }); return a; };
    const src = sig(mk(5, "a"));
    const m = mapArr(src, byValueMapFn(), { byValue: true });
    let s = m.stats();
    assert.equal(s.live, 5); assert.equal(s.parked, 0); assert.equal(s.highWater, 5);

    src.set(mk(5, "b"));                                       // 5 all-new keys in one set
    s = m.stats();
    assert.equal(s.live, 5, "settled live is 5");
    assert.equal(s.parked, 0, "byValue parks nothing even on a replace-all");
    assert.equal(s.highWater, 10, "replace-all coexists both generations: prevN+n transient");

    src.set([]);                                              // drop all: immediate dispose
    s = m.stats();
    assert.equal(s.live, 0); assert.equal(s.parked, 0); assert.equal(s.highWater, 10);

    m.dispose();
    assert.equal(s.live, 0); assert.equal(s.parked, 0);
    assert.equal(s.highWater, 10, "highWater is historical -- survives dispose()");
});
