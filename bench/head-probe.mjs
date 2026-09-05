// bench/head-probe.mjs -- node bench/head-probe.mjs   (NO --expose-gc)
//
// The HEAD fast-path decision probe for @zakkster/lite-map C4 (M-05). It answers
// one question with numbers, fail-closed: does a head fast-path recover enough of
// the reconcile cost to earn unconditional bytes in the hot body? The tail fast-
// paths won 15x because append/pop have O(delta) inherent work and ZERO index
// shifts. A head mutation (prepend, shift, head-cycle) has NEITHER property --
// every survivor's index genuinely shifts, so the idxSig fan-out and the full o[]
// rewrite are INHERENT and only constant-factor diff bookkeeping is recoverable.
//
// DECISION OUTCOME (decisions/0003-head-fast-path.md): the H-1 prototype cleared
// 0.25 at both sizes, but the SHIPPED fast path, re-measured (R3) against a near-
// head general-path proxy, did NOT robustly clear 0.25 at BOTH sizes outside the
// wall-clock spread -- it straddled the bar at n=1000. Per the fail-closed
// discipline the choice is B: no head fast-path ships, Map.js is byte-identical to
// 0f92d70. This bench remains on the record as the recoverable-share isolate.
//
// WHAT IT MEASURES
//   ANALYTIC (structural, two-run byte-identical): for each head shape at n=100
//   and n=1000 -- idxSets (measured live via an index-effect rerun counter, the
//   t6-alloc.mjs idxRuns discipline), and the DERIVED per-shape general-path
//   counts oStores == n, byKeyGets == n, retireScan == prevN. Each row is put
//   through a fail-closed classifier; a row it cannot classify prints
//   path=UNCLASSIFIED with "-" in every derived column and the run EXITS 1.
//   TIMED (machine-local, excluded from the determinism check): head-cycle end-
//   to-end reconcile wall-clock vs a bench-local TWIN that performs, on real
//   engine primitives, exactly the INHERENT head ops per cycle. The recoverable
//   share upper bound is (medianReal - medianTwin) / medianReal. The twin under-
//   estimates any real fast path (it omits byKey.get / retire-scan / scratch-swap
//   entirely), so the derived win is an OVERESTIMATE -- the error points toward
//   option A, and a failing overestimate settles option B a fortiori.
//
// WHY THE "grow" REGISTRY IS LEGITIMATE HERE (and ONLY here)
//   This file binds its mapper to createRegistry({ onCapacityExceeded: 'grow' }).
//   That is legitimate ONLY because this bench GATES NOTHING -- it asserts nothing
//   about allocation. Under any gate in test/ a "grow" registry is the M-02 trap
//   and must never appear there. This file is NEVER imported by test/ and is NEVER
//   listed in package.json files[]. It imports NOTHING from test/.
//
// @license MIT

import { readFileSync } from 'node:fs';
import { createRegistry } from '@zakkster/lite-signal';
import { createMapper } from '../Map.js';

// ---- resolved lite-signal version (for a replayable header) -----------------
const SIG_VER = JSON.parse(
    readFileSync(new URL('../node_modules/@zakkster/lite-signal/package.json', import.meta.url), 'utf8'),
).version;

// ---- source anchors: the derived columns describe the SHIPPED code ONLY while
// these hold. Read Map.js as text; if any drifts, fail loudly (exit 2) instead of
// printing a stale number. Everything inside the mapArray general-diff region is
// bounded from the '// ---- general keyed diff' marker to the next 'function '
// declaration (mapArrayByValue), exactly as lis-probe.mjs bounds its N1 anchor.
const MAP_SRC = readFileSync(new URL('../Map.js', import.meta.url), 'utf8');
const A_EXISTING = 'const existing = byKey.get(key);';
const A_RETIRE = 'for (let i = 0; i < slots.length; i++)';
const A_SWAP = 'const tmp = slots; slots = scratch; scratch = tmp;';
const A_REWRITE = 'for (let i = 0; i < n; i++) o[i] = slots[i].view;';
const A_CHANGED = 'if (changed) {';
const A_PREFIX = 'while (p < lim && keyOf(arr[p]) === slots[p].key) p++;';

// These anchors prove the general-diff region is INTACT, not that any given
// shape ROUTES through a fast path -- true while no fast path exists; if one
// is ever added, the classifier model here must be re-derived (see the
// decisions/0003 amendment).
const GI = MAP_SRC.indexOf('// ---- general keyed diff');
const NEXT_FN = GI === -1 ? -1 : MAP_SRC.indexOf('function ', GI);
const REGION = GI === -1 ? '' : MAP_SRC.slice(GI, NEXT_FN === -1 ? GI + 2000 : NEXT_FN);
const i_existing = REGION.indexOf(A_EXISTING);
const i_retire = REGION.indexOf(A_RETIRE);
const i_swap = REGION.indexOf(A_SWAP);
const i_changed = REGION.indexOf(A_CHANGED);
const i_rewrite = REGION.indexOf(A_REWRITE);
const i_prefix = MAP_SRC.indexOf(A_PREFIX); // prefix scan sits BEFORE the general region
const anchored = GI !== -1 && i_existing !== -1 && i_retire !== -1 && i_swap !== -1 &&
    i_changed !== -1 && i_rewrite !== -1 && i_rewrite > i_changed && i_prefix !== -1;
if (!anchored) {
    console.error('bench: source anchor FAILED -- the mapArray general keyed diff changed or moved.');
    console.error('bench: a derived column would no longer describe the shipped code. Refusing to print a fiction.');
    process.exit(2);
}

// ---- one grow registry for the whole bench ---------------------------------
const reg = createRegistry({ prealloc: 'eager', onCapacityExceeded: 'grow' });

// ---- the realistic consumer: ONE index-effect per row (idxRuns discipline) --
// The view reads the item once (non-reactive; head shapes never change an item)
// and carries exactly one reactive index effect -- the fan-out a head mutation
// inherently drives. Matches the twin's "one consumer effect per signal".
function benchMapFn(idxRuns) {
    return (itemAcc, idxAcc) => {
        const view = { item: itemAcc(), index: idxAcc() };
        reg.effect(() => { view.index = idxAcc(); idxRuns.n++; });
        return view;
    };
}

let NEXT_ID = 1;
function freshItems(count) {
    const a = new Array(count);
    for (let k = 0; k < count; k++) a[k] = { id: NEXT_ID++ };
    return a;
}

function build(count) {
    const idxRuns = { n: 0 };
    const outFires = { n: 0 };
    const mapper = createMapper(reg);
    const base = freshItems(count);
    const src = reg.signal(base.slice(), { equals: () => false });
    const mapped = mapper.mapArray(src, benchMapFn(idxRuns), { key: (r) => r.id });
    const stop = reg.effect(() => { void mapped(); outFires.n++; });
    return { idxRuns, outFires, base, src, mapped, stop };
}

// ---- ANALYTIC: one representative reconcile per shape, structural counts -----
// prepend:    prevN -> prevN+1 (fresh head unshifted)
// shift:      prevN -> prevN-1 (head dropped)
// head-cycle: prevN -> prevN   (tail popped, fresh head unshifted; stable n)
function runAnalytic(shape, size) {
    let inst, work;
    if (shape === 'prepend') {
        inst = build(size);
        work = inst.base.slice();
        work.unshift({ id: NEXT_ID++ });
    } else if (shape === 'shift') {
        inst = build(size + 1);
        work = inst.base.slice();
        work.shift();
    } else { // head-cycle
        inst = build(size);
        work = inst.base.slice();
        work.pop();
        work.unshift({ id: NEXT_ID++ });
    }
    const prevN = inst.mapped().length;
    inst.idxRuns.n = 0;
    inst.outFires.n = 0;
    inst.src.set(work);
    const idxSets = inst.idxRuns.n;
    const outDelta = inst.outFires.n;
    const n = inst.mapped().length;

    // fail-closed classifier per shape
    let classified;
    if (shape === 'head-cycle') classified = prevN === n && outDelta === 1 && idxSets > 0;
    else if (shape === 'prepend') classified = n === prevN + 1 && outDelta === 1 && idxSets >= prevN;
    else classified = n === prevN - 1 && outDelta === 1 && idxSets >= n; // shift

    inst.stop();
    inst.mapped.dispose();

    return {
        shape, n, prevN, idxSets, classified,
        oStores: classified ? n : '-',       // DERIVED: general path rewrites 0..n
        byKeyGets: classified ? n : '-',      // DERIVED: one byKey.get per new item
        retireScan: classified ? prevN : '-', // DERIVED: retire scan spans prevN slots
        path: classified ? 'general' : 'UNCLASSIFIED',
    };
}

// ---- the TWIN: inherent head ops per cycle, on real engine primitives -------
// Built from scratch (no Map.js text copied). Per cycle at stable n:
//   n idxSig.set on n live signals EACH carrying one consumer effect (fan-out);
//   an n-element in-place memmove re-seat (no allocation);
//   n stores into ONE persistent output array;
//   one out.set-equivalent signal set;
//   one pool pop + push pair.
function buildTwin(n) {
    const idxSigs = new Array(n);
    const tslots = new Array(n);
    const tout = new Array(n);
    let twinRuns = 0;
    for (let k = 0; k < n; k++) {
        const s = reg.signal(k);
        idxSigs[k] = s;
        const view = { item: null, index: k };
        tslots[k] = { view };
        const acc = () => s();                                 // accessor indirection (matches idxAcc)
        reg.effect(() => { view.index = acc(); twinRuns++; }); // consumer effect, byte-for-byte weight of the real one
    }
    const to = reg.signal(tout, { equals: () => false });
    reg.effect(() => { void to(); });           // out-flush consumer
    const parkPool = [{ view: { id: -1 } }];     // persistent single-slot pool
    let idxCtr = 0;
    return function cycle() {
        const retired = tslots[n - 1];           // tail retired
        for (let i = n - 1; i > 0; i--) tslots[i] = tslots[i - 1]; // in-place memmove
        tslots[0] = retired;                     // reuse retired as fresh head (re-seat, no alloc)
        const base = (++idxCtr);
        for (let k = 0; k < n; k++) idxSigs[k].set(base + k); // n idxSig.set, each fans out
        for (let i = 0; i < n; i++) tout[i] = tslots[i].view; // n stores into one array
        to.set(tout);                            // one out.set-equivalent
        const parked = parkPool.pop(); parkPool.push(parked); // one pop + push pair
        return twinRuns;
    };
}

// ---- the STAGE-2 PROTOTYPE: a FAITHFUL bench-side head fast-path -------------
// The amendment's minimal proto (twin + a bare key-scan) OMITS work a REAL head
// fast path unavoidably pays -- byKey.delete/set for the retired tail and the new
// head, the itemSig.set on the new head, the per-survivor idxSig.set re-seat, the
// keyOf detection scan. Micro-isolation showed byKey.get x n is only ~5us at
// n=1000, so a proto that skips it is a LOOSE overestimate biased toward A. To
// decide honestly (fail-closed toward B), this proto performs, on real engine
// primitives, EVERYTHING a shipped head fast-path would: it is the tightest
// lower bound available short of editing Map.js. If even THIS does not clear
// 0.25, option A is dead. (This is R3 done early: measure the real work, not a
// flattering sketch.)
//
// NOTE (borne out by R3): even this faithful proto is OPTIMISTIC vs the SHIPPED
// path. It identifies survivors POSITIONALLY and skips the general path's per-row
// byKey.get; the shipped path could not skip it (that lookup disambiguates
// DUPLICATE keys, Map.js:350, and enforces retire ownership, Map.js:277). A
// positional path that drops it is NOT semantics byte-identical, so the share
// below is a TIMING UPPER BOUND for a UNIQUE-KEY input only -- and the R3 re-
// measure of the honest, byte-identical shipped path fell BELOW 0.25 at n=1000.
function buildProto(n) {
    const byKey = new Map();
    let slots = new Array(n);
    const o = new Array(n);
    const out = reg.signal(o, { equals: () => false });
    reg.effect(() => { void out(); });
    const pool = [];
    const keyOf = (r) => r.id;
    let epoch = 0;
    for (let k = 0; k < n; k++) {
        const item = { id: k };
        const itemSig = reg.signal(item);
        const idxSig = reg.signal(k);
        const view = { item, index: k };
        const acc = () => idxSig();
        reg.effect(() => { view.index = acc(); });     // one index effect per row (matches real)
        const s = { itemSig, idxSig, view, key: k, index: k, item, seen: 0 };
        slots[k] = s; byKey.set(k, s); o[k] = view;
    }
    out.set(o);
    // Prebuilt real head-cycle INPUT arrays (outside the timer): detection must
    // scan the NEW input, not the slots' own keys. An offset-1 scan reading a
    // separate array is the real cache-traffic cost of detecting a head-cycle
    // (both ends mutate, so prefix AND suffix are 0 -- only an offset scan finds
    // it). A self-key compare would be unrealistically cheap and flatter A.
    const total = WARM + REPS * CYCLES;
    const inputs = new Array(total);
    let nextId = n;
    const body = new Array(n);
    for (let k = 0; k < n; k++) body[k] = slots[k].item;
    for (let c = 0; c < total; c++) {
        const inp = new Array(n);
        inp[0] = { id: nextId++ };
        for (let i = 1; i < n; i++) inp[i] = body[i - 1];
        for (let i = n - 1; i > 0; i--) body[i] = body[i - 1];
        body[0] = inp[0];
        inputs[c] = inp;
    }
    let ptr = 0;
    return function cycle() {
        epoch = (epoch + 1) | 0;
        const input = inputs[ptr++];
        const newItem = input[0];
        const newKey = newItem.id;
        // detection: real offset-1 key scan against the new input array (the head-
        // cycle signature keyOf(input[i]) === slots[i-1].key). Pure, no effects.
        let ok = true;
        for (let i = 1; i < n; i++) { if (keyOf(input[i]) !== slots[i - 1].key) ok = false; }
        void ok;
        // retire the dropped tail (byKey management + pool return).
        const tail = slots[n - 1];
        if (byKey.get(tail.key) === tail) byKey.delete(tail.key);
        pool.push(tail);
        // acquire the fresh head from the pool (rebind signals, re-register key).
        const s = pool.pop();
        if (byKey.get(s.key) === s) byKey.delete(s.key);
        s.key = newKey; s.index = 0; s.item = newItem; s.seen = epoch;
        s.itemSig.set(newItem);
        s.idxSig.set(0);
        byKey.set(newKey, s);
        // re-seat survivors in place, each pays its inherent idxSig.set fan-out.
        for (let i = n - 1; i > 0; i--) { const sv = slots[i - 1]; slots[i] = sv; sv.index = i; sv.idxSig.set(i); }
        slots[0] = s;
        for (let i = 0; i < n; i++) o[i] = slots[i].view;
        out.set(o);
    };
}

// ---- timing methodology (shared by real / twin / proto) ---------------------
const WARM = 300;    // >= 200 warmup cycles
const REPS = 7;      // >= 5 repeats
const CYCLES = 600;  // >= 500 cycles per repeat

// ---- real head-cycle cycle (times ONLY src.set) -----------------------------
// The consumer's array construction (the O(n) head-shift + fresh head object) is
// prebuilt OUTSIDE the timer: it is neither reconcile work nor recoverable by any
// fast path, and the twin never pays it -- timing it on the real side ONLY would
// inflate the recoverable share toward option A (dishonest, fail-open). So each
// timed cycle is exactly one src.set of a pre-materialised head-cycle input.
function buildRealHeadCycle(n) {
    const idxRuns = { n: 0 };
    const mapper = createMapper(reg);
    const work = freshItems(n);
    const src = reg.signal(work.slice(), { equals: () => false });
    const mapped = mapper.mapArray(src, benchMapFn(idxRuns), { key: (r) => r.id });
    const stop = reg.effect(() => { void mapped(); });
    const total = WARM + REPS * CYCLES;
    const arrs = new Array(total);                 // prebuilt head-cycle inputs
    for (let c = 0; c < total; c++) {
        for (let i = n - 1; i > 0; i--) work[i] = work[i - 1]; // drop tail, shift up
        work[0] = { id: NEXT_ID++ };                           // fresh head
        arrs[c] = work.slice();
    }
    let ptr = 0;
    return function cycle() { src.set(arrs[ptr++]); return idxRuns.n; };
}
function timeLoop(cycle) {
    for (let i = 0; i < WARM; i++) cycle();
    const s = new Array(REPS);
    for (let r = 0; r < REPS; r++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < CYCLES; i++) cycle();
        const t1 = process.hrtime.bigint();
        s[r] = Number(t1 - t0) / CYCLES / 1000; // us per cycle
    }
    s.sort((a, b) => a - b);
    return { median: s[REPS >> 1], min: s[0], max: s[REPS - 1] };
}

// ---- table helpers ----------------------------------------------------------
function pad(v, w) { const s = String(v); return s + ' '.repeat(Math.max(0, w - s.length)); }
function us(x) { return x.toFixed(2); }
function frac(x) { return x.toFixed(3); }

const SIZES = [100, 1000];
const SHAPES = ['prepend', 'shift', 'head-cycle'];

// ============================ ANALYTIC ======================================
console.log('lite-map head-probe -- lite-signal=' + SIG_VER);
console.log('ANALYTIC (two-run byte-identical)');
console.log(
    pad('shape', 11) + ' ' + pad('n', 5) + ' ' + pad('prevN', 6) + ' ' +
    pad('idxSets', 8) + ' ' + pad('oStores', 8) + ' ' + pad('byKeyGets', 10) + ' ' +
    pad('retireScan', 11) + ' ' + 'path',
);

let anyUnclassified = false;
for (let z = 0; z < SIZES.length; z++) {
    for (let s = 0; s < SHAPES.length; s++) {
        const r = runAnalytic(SHAPES[s], SIZES[z]);
        if (!r.classified) anyUnclassified = true;
        console.log(
            pad(r.shape, 11) + ' ' + pad(r.n, 5) + ' ' + pad(r.prevN, 6) + ' ' +
            pad(r.idxSets, 8) + ' ' + pad(r.oStores, 8) + ' ' + pad(r.byKeyGets, 10) + ' ' +
            pad(r.retireScan, 11) + ' ' + r.path,
        );
    }
}
if (anyUnclassified) {
    console.error('bench: at least one head shape did not classify as general -- see path=UNCLASSIFIED.');
    process.exit(1);
}

// ============================ TIMED =========================================
console.log('');
console.log('TIMED (machine-local, excluded from determinism check)');
console.log('node=' + process.version + ' platform=' + process.platform + '/' + process.arch +
    ' warm=' + WARM + ' reps=' + REPS + ' cycles=' + CYCLES);
console.log(
    pad('size', 6) + ' ' + pad('realUs', 9) + ' ' + pad('spread', 17) + ' ' +
    pad('twinUs', 9) + ' ' + pad('shareUpper', 10),
);

const shareBySize = {};
const shareWorstBySize = {};
for (let z = 0; z < SIZES.length; z++) {
    const n = SIZES[z];
    const real = timeLoop(buildRealHeadCycle(n));
    const twin = timeLoop(buildTwin(n));
    const shareUpper = (real.median - twin.median) / real.median;
    const shareWorst = (real.median - twin.max) / real.median; // twin slowest -> smallest gap
    shareBySize[n] = shareUpper;
    shareWorstBySize[n] = shareWorst;
    console.log(
        pad(n, 6) + ' ' + pad(us(real.median), 9) + ' ' +
        pad(us(real.min) + '..' + us(real.max), 17) + ' ' +
        pad(us(twin.median), 9) + ' ' + pad(frac(shareUpper), 10),
    );
}

// ---- H-1 STAGE 1 verdict (mechanical) --------------------------------------
console.log('');
const s100 = shareBySize[100], s1000 = shareBySize[1000];
const w100 = shareWorstBySize[100], w1000 = shareWorstBySize[1000];
console.log('H-1 stage 1: shareUpper n=100=' + frac(s100) + ' n=1000=' + frac(s1000) +
    ' | shareWorst(spread-adjusted) n=100=' + frac(w100) + ' n=1000=' + frac(w1000) + ' | bar=0.250');
const passMedian = s100 >= 0.25 && s1000 >= 0.25;
const straddle = (s100 >= 0.25 && w100 < 0.25) || (s1000 >= 0.25 && w1000 < 0.25);
const passStage1 = passMedian && !straddle;
if (!passStage1) {
    const why = !passMedian ? 'shareUpper < 0.25 at ' + (s100 < 0.25 ? 'n=100' : 'n=1000')
        : 'straddle: 0.25 falls within spread';
    console.log('H-1 FAILS (stage 1) -> B  (' + why + ')');
} else {
    console.log('stage 2 required (shareUpper >= 0.25 at BOTH sizes, gap > spread)');
    console.log('');
    console.log('H-1 STAGE 2 (prototype: FAITHFUL bench-side head fast-path)');
    console.log(pad('size', 6) + ' ' + pad('realUs', 9) + ' ' + pad('protoUs', 9) + ' ' + pad('shareProto', 10));
    let p100, p1000, pw100, pw1000;
    for (let z = 0; z < SIZES.length; z++) {
        const n = SIZES[z];
        const real = timeLoop(buildRealHeadCycle(n));
        const proto = timeLoop(buildProto(n));
        const shareProto = (real.median - proto.median) / real.median;
        const shareProtoWorst = (real.median - proto.max) / real.median;
        if (n === 100) { p100 = shareProto; pw100 = shareProtoWorst; } else { p1000 = shareProto; pw1000 = shareProtoWorst; }
        console.log(pad(n, 6) + ' ' + pad(us(real.median), 9) + ' ' + pad(us(proto.median), 9) + ' ' + pad(frac(shareProto), 10));
    }
    const passProto = p100 >= 0.25 && p1000 >= 0.25;
    const straddleProto = (p100 >= 0.25 && pw100 < 0.25) || (p1000 >= 0.25 && pw1000 < 0.25);
    if (passProto && !straddleProto) console.log('H-1 CLEARS (stage 2) -> option A candidate; the SHIPPED path is then gated by R3 (see 0003 -- R3 MISSED, choice B)');
    else console.log('H-1 FAILS (stage 2) -> B  (' + (!passProto ? 'shareProto < 0.25' : 'straddle within spread') + ')');
}
