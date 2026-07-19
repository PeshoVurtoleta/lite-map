/**
 * bench/torture/maparray-fuzzer.mjs -- seeded, oracle-checked map reconciliation soak.
 *
 * Not a benchmark -- CRASH + CORRECTNESS detection:
 *
 *   - mapArray FUZZ    random append/pop/prepend/insert/remove/reorder/value-churn.
 *     After every step: output order + values match a plain oracle; every SURVIVING
 *     row keeps its scope (sid stable); every row's reactive index accessor equals
 *     its position (slots[i].index === i).
 *   - indexArray FUZZ  random length changes + value churn match the oracle.
 *   - TAIL OSCILLATION a long push/pop oscillation on a large warm list is zero-GC
 *     (pool flat), exercising the 1.1 tail fast-paths under load.
 *
 * Exit code: 0 on clean run, 1 on any assertion failure.
 * Usage: node bench/torture/maparray-fuzzer.mjs           (TORTURE_SCALE=10 to crank)
 *
 * NOTE: binds an isolated registry with onCapacityExceeded:"grow"; source signals,
 * effects, mapper and stats all share it.
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { createMapper } from "../../Map.js";

const R = createRegistry({ maxNodes: 1 << 20, maxLinks: 1 << 22, onCapacityExceeded: "grow" });
const { mapArray, indexArray } = createMapper(R);
const SCALE = Math.max(1, Number(process.env.TORTURE_SCALE) || 1);

function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const ri = (rand, n) => Math.floor(rand() * n);

let SID = 0;
function trackingMapFn() {
    return (itemAcc, idxAcc) => {
        const view = { item: itemAcc(), index: idxAcc(), sid: SID++ };
        R.effect(() => { view.item = itemAcc(); });
        R.effect(() => { view.index = idxAcc(); });
        return view;
    };
}
const keyById = { key: (r) => r.id };

function mapArrayFuzz() {
    const rand = rng(0xA11CE);
    let nextId = 0;
    const mkRow = () => ({ id: nextId++, v: ri(rand, 1000) });
    let model = []; for (let i = 0; i < 8; i++) model.push(mkRow());
    const src = R.signal(model.slice());
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = R.effect(() => { void mapped(); });
    let sidById = new Map(mapped().map((v) => [v.item.id, v.sid]));

    const ITERS = 5000 * SCALE;
    for (let i = 0; i < ITERS; i++) {
        const op = ri(rand, 8);
        if (op === 0) model.push(mkRow());
        else if (op === 1 && model.length) model.pop();
        else if (op === 2) model.unshift(mkRow());
        else if (op === 3) model.splice(ri(rand, model.length + 1), 0, mkRow());
        else if (op === 4 && model.length) model.splice(ri(rand, model.length), 1);
        else if (op === 5 && model.length > 1) { const a = ri(rand, model.length), b = ri(rand, model.length); const t = model[a]; model[a] = model[b]; model[b] = t; }
        else if (op === 6 && model.length) { const idx = ri(rand, model.length); model[idx] = { id: model[idx].id, v: ri(rand, 1000) }; }
        else if (model.length) { const a = ri(rand, model.length), b = ri(rand, model.length); const [lo, hi] = a < b ? [a, b] : [b, a]; model = model.slice(0, lo).concat(model.slice(lo, hi + 1).reverse(), model.slice(hi + 1)); }

        const before = sidById;
        src.set(model.slice());
        const out = mapped();
        assert.deepEqual(out.map((v) => v.item.id), model.map((r) => r.id), `ids iter ${i}`);
        assert.deepEqual(out.map((v) => v.item.v), model.map((r) => r.v), `values iter ${i}`);
        const nextSidById = new Map();
        for (let j = 0; j < out.length; j++) {
            assert.equal(out[j].index, j, `index === position iter ${i} pos ${j}`);
            const id = out[j].item.id;
            if (before.has(id)) assert.equal(out[j].sid, before.get(id), `survivor ${id} kept scope iter ${i}`);
            nextSidById.set(id, out[j].sid);
        }
        sidById = nextSidById;
    }
    stop(); mapped.dispose();
    return `${(5000 * SCALE).toLocaleString()} random ops, order+identity+index held`;
}

function indexArrayFuzz() {
    const rand = rng(0x1DEA);
    let model = []; for (let i = 0; i < 5; i++) model.push(ri(rand, 1000));
    const src = R.signal(model.slice());
    const mapped = indexArray(src, (itemAcc, index) => {
        const view = { item: itemAcc(), index };
        R.effect(() => { view.item = itemAcc(); });
        return view;
    });
    const stop = R.effect(() => { void mapped(); });
    const ITERS = 5000 * SCALE;
    for (let i = 0; i < ITERS; i++) {
        const op = ri(rand, 5);
        if (op === 0) model.push(ri(rand, 1000));
        else if (op === 1 && model.length) model.pop();
        else if (op === 2 && model.length) model[ri(rand, model.length)] = ri(rand, 1000);
        else if (op === 3) { model = []; for (let k = 0, n = ri(rand, 12); k < n; k++) model.push(ri(rand, 1000)); }
        else if (model.length) model.length = ri(rand, model.length + 1);
        src.set(model.slice());
        const out = mapped();
        assert.deepEqual(out.map((v) => v.item), model, `indexArray content iter ${i}`);
        for (let j = 0; j < out.length; j++) assert.equal(out[j].index, j, `indexArray index iter ${i}`);
    }
    stop(); mapped.dispose();
    return `${(5000 * SCALE).toLocaleString()} random length/value ops`;
}

function tailOscillation() {
    const N = 400;
    const base = []; for (let i = 0; i < N; i++) base.push({ id: i, v: i });
    const src = R.signal(base.slice());
    const mapped = mapArray(src, trackingMapFn(), keyById);
    const stop = R.effect(() => { void mapped(); });
    src.set(base.concat({ id: -1, v: 0 })); src.set(base.slice());   // warm the pool
    const b0 = R.stats();
    const CYCLES = 5000 * SCALE;
    for (let c = 0; c < CYCLES; c++) { src.set(base.concat({ id: 1_000_000 + c, v: c })); src.set(base.slice()); }
    const b1 = R.stats();
    assert.equal(b1.poolGrowths - b0.poolGrowths, 0, "pool grew during oscillation");
    assert.equal(b1.totalAllocations - b0.totalAllocations, 0, "nodes allocated during oscillation");
    assert.deepEqual(mapped().map((v) => v.item.id), base.map((r) => r.id), "list not restored");
    stop(); mapped.dispose();
    return `${CYCLES.toLocaleString()} push/pop cycles on a ${N}-row list, pool flat`;
}

const t0 = performance.now();
let failures = 0;
function run(name, fn) {
    const s = performance.now();
    try { const info = fn(); console.log(`  PASS ${name}${info ? " -- " + info : ""} (${((performance.now() - s) / 1000).toFixed(2)}s)`); }
    catch (e) { failures++; console.error(`  FAIL ${name}: ${e.message}`); }
}

console.log(`lite-map reconciliation fuzzer (seeded, oracle-checked; scale ${SCALE})`);
run("mapArray keyed fuzz", mapArrayFuzz);
run("indexArray positional fuzz", indexArrayFuzz);
run("tail push/pop oscillation is pool-flat", tailOscillation);
console.log(`${failures ? "FAIL" : "PASS"}: ${failures} failure(s) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
process.exit(failures ? 1 : 0);
