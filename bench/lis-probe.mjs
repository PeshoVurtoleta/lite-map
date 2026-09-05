// bench/lis-probe.mjs -- node bench/lis-probe.mjs   (NO --expose-gc)
//
// The LIS decision probe for @zakkster/lite-map C3 (M-01). It characterises the
// by-accessor GENERAL reconcile path (Map.js general keyed diff) on five
// same-length permutation shapes at n = 1000, and reports the four numbers the
// decision in decisions/0002-lis-ordering.md turns on:
//
//   (1) moved      -- idxSig.set writes today (genuinely-moved rows). Measured
//                     live via an index-effect rerun counter (the t6-alloc.mjs
//                     idxRuns pattern), reset immediately before each set().
//   (2) oStores    -- o[] slot stores on the general path. DERIVED, not counted:
//                     the rewrite loop at Map.js:370 is unconditional over 0..n
//                     and reached only when `changed` is true, so on the general
//                     path stores == n. The bench PROVES the general/changed path
//                     ran (classifier below) and multiplies; a row it cannot
//                     classify prints path=UNCLASSIFIED and the run exits non-zero.
//   (3) n - LIS    -- the classic MOVE-operation floor for an insertion-ordered
//                     container. Computed bench-side, allocating freely (this file
//                     gates nothing, so no zero-GC rule applies).
//   (4) redundant  -- n - moved: positions whose occupant did not change, where
//                     the store at Map.js:370 rewrites o[i] with the value it
//                     already holds. This is the floor a POSITIONALLY-indexed
//                     output array actually has, and it diverges sharply from
//                     n - LIS (rotate-by-1: n - LIS == 1 but redundant == 0).
//
// This file is NEVER imported by test/ and NEVER listed in package.json files[].
// It binds createMapper to its OWN createRegistry({ onCapacityExceeded: 'grow' })
// registry; that is legitimate ONLY because the bench asserts nothing about
// allocation -- a "grow" registry under any GATE is the M-02 trap and must never
// appear in test/.
//
// @license MIT

import { readFileSync } from 'node:fs';
import { createRegistry } from '@zakkster/lite-signal';
import { createMapper } from '../Map.js';

const N = 1000;

// ---- resolved lite-signal version (for a replayable header) ----------------
const SIG_VER = JSON.parse(
    readFileSync(new URL('../node_modules/@zakkster/lite-signal/package.json', import.meta.url), 'utf8'),
).version;

// ---- determinism: bench-local xorshift32 (mirrors harness.mjs:51-67) --------
// Duplicated, never imported, so bench/ never depends on test/ and never pulls
// in lite-gc-profiler (which would make --expose-gc matter).
const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

// ---- source anchor (borrowed from the instrumented-fork option's one virtue)-
// The oStores number describes the SHIPPED loop only while that loop is byte
// unchanged. Read Map.js as text and assert the general-path rewrite still reads
// exactly this, inside the `if (changed)` block. If anyone edits it (including a
// future LIS pass), fail loudly instead of reporting a stale number.
const MAP_SRC = readFileSync(new URL('../Map.js', import.meta.url), 'utf8');
const LOOP = 'for (let i = 0; i < n; i++) o[i] = slots[i].view;';
const GI = MAP_SRC.indexOf('// ---- general keyed diff');
const REGION = GI === -1 ? '' : MAP_SRC.slice(GI, GI + 2000);
const CI = REGION.indexOf('if (changed) {');
const LI = REGION.indexOf(LOOP);
// Bound the loop to the enclosing function, not just "somewhere in a 2000-char
// window": it must sit AFTER `if (changed) {` and BEFORE the next `function `
// declaration (searched in the full source, since that boundary can fall
// outside the 2000-char window) -- a lexically-inside-the-if-block proxy
// without a real parser.
const NEXT_FN = GI === -1 || CI === -1 ? -1 : MAP_SRC.indexOf('function ', GI + CI);
const anchored = GI !== -1 && CI !== -1 && LI !== -1 && LI > CI &&
    (NEXT_FN === -1 || (GI + LI) < NEXT_FN);
if (!anchored) {
    console.error('bench: source anchor FAILED -- the general-path rewrite loop at Map.js:370 changed or moved.');
    console.error('bench: the oStores column would no longer describe the shipped code. Refusing to print a fiction.');
    process.exit(2);
}

// ---- shapes: same-length permutations of an identity base ------------------
// Each returns an array of key indices; arrangement[j] = stableItems[perm[j]].
function shapeRotate1() {
    const p = new Array(N);
    for (let j = 0; j < N; j++) p[j] = (j + 1) % N; // [1,2,...,N-1,0]
    return p;
}
function shapeReverse() {
    const p = new Array(N);
    for (let j = 0; j < N; j++) p[j] = N - 1 - j;
    return p;
}
function shapeShuffle() {
    const rng = makePrng(SEED);
    const p = new Array(N);
    for (let j = 0; j < N; j++) p[j] = j;
    for (let j = N - 1; j > 0; j--) {
        const k = rng() % (j + 1);
        const t = p[j]; p[j] = p[k]; p[k] = t;
    }
    return p;
}
function shapeAdjacentSwap() {
    const p = new Array(N);
    for (let j = 0; j < N; j++) p[j] = j;
    const mid = N >> 1;                 // one adjacent pair swapped -> exactly 2 moved
    const t = p[mid]; p[mid] = p[mid + 1]; p[mid + 1] = t;
    return p;
}
function shapeMoves25() {
    const rng = makePrng(SEED);
    const p = new Array(N);
    for (let j = 0; j < N; j++) p[j] = j;
    const count = (N * 0.25) | 0;       // 250 splice-moves: pull an element and reinsert it elsewhere
    for (let m = 0; m < count; m++) {
        const from = rng() % N;
        const to = rng() % N;
        const el = p.splice(from, 1)[0];
        p.splice(to, 0, el);
    }
    return p;
}

const SHAPES = [
    ['rotate-by-1', shapeRotate1],
    ['reverse', shapeReverse],
    ['shuffle', shapeShuffle],
    ['adjacent-swap', shapeAdjacentSwap],
    ['moves-25pct', shapeMoves25],
];

// ---- bench-side LIS (classic patience/tails, O(n log n), allocates freely) --
function lisLength(a) {
    const tails = [];
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < x) lo = mid + 1; else hi = mid; }
        if (lo === tails.length) tails.push(x); else tails[lo] = x;
    }
    return tails.length;
}

// n - LIS between the previous arrangement (base identity) and the new one.
// A is indexed by OLD position; A[oldPos] = newPos of the same key. LIS(A) is the
// longest run that keeps relative order; n - LIS is the classic move floor.
function nMinusLis(baseIds, newIds) {
    const n = baseIds.length;
    const newPos = new Map();
    for (let j = 0; j < n; j++) newPos.set(newIds[j], j);
    const A = new Array(n);
    for (let j = 0; j < n; j++) A[j] = newPos.get(baseIds[j]); // baseIds[j] is the key at old position j
    const lis = lisLength(A);
    return { lis, nlis: n - lis };
}

// ---- the by-accessor general mapFn (index effect increments idxRuns) --------
function benchMapFn(reg, idxRuns) {
    return (itemAcc, idxAcc) => {
        const view = { item: itemAcc(), index: idxAcc(), sid: 0 };
        reg.effect(() => { view.item = itemAcc(); });
        reg.effect(() => { view.index = idxAcc(); idxRuns.n++; });
        return view;
    };
}

// ---- one grow registry for the whole bench; fresh mapper + base per shape ---
const reg = createRegistry({ prealloc: 'eager', onCapacityExceeded: 'grow' });

const stableItems = new Array(N);
for (let k = 0; k < N; k++) stableItems[k] = { id: k };
const baseIds = new Array(N);
for (let k = 0; k < N; k++) baseIds[k] = k; // identity arrangement's key at position k

function runShape(makePerm) {
    const mapper = createMapper(reg);
    const idxRuns = { n: 0 };
    const outFires = { n: 0 };
    const mapFn = benchMapFn(reg, idxRuns);

    // fresh base array (identity) for this shape
    const baseArr = new Array(N);
    for (let k = 0; k < N; k++) baseArr[k] = stableItems[k];

    const src = reg.signal(baseArr.slice(), { equals: () => false });
    const mapped = mapper.mapArray(src, mapFn, { key: (r) => r.id });
    const stop = reg.effect(() => { void mapped(); outFires.n++; });

    const prevN = mapped().length;

    // build the shape arrangement (references to the SAME stable items -> survivors)
    const perm = makePerm();
    const newArr = new Array(N);
    const newIds = new Array(N);
    for (let j = 0; j < N; j++) { newArr[j] = stableItems[perm[j]]; newIds[j] = perm[j]; }

    // reset the two live counters immediately BEFORE the measured set (t6:186 discipline)
    idxRuns.n = 0;
    outFires.n = 0;
    src.set(newArr.slice());

    const moved = idxRuns.n;
    const outDelta = outFires.n;
    const n = mapped().length;

    // classifier (fail-closed): general/changed <=> prevN === n AND exactly one
    // out flush AND at least one idxSig.set. Any other combination is unproven.
    const classified = prevN === n && outDelta === 1 && moved > 0;
    const path = classified ? 'general' : 'UNCLASSIFIED';
    const oStores = classified ? n : NaN;

    const { lis, nlis } = nMinusLis(baseIds, newIds);
    const redundant = n - moved;

    stop();
    mapped.dispose();

    return { n, moved, oStores, lis, nlis, redundant, path, classified };
}

// ---- table ------------------------------------------------------------------
function pad(s, w) { s = String(s); return s + ' '.repeat(Math.max(0, w - s.length)); }

const HEX = '0x' + (SEED >>> 0).toString(16);
console.log('lite-map LIS probe -- seed=' + HEX + ' lite-signal=' + SIG_VER + ' n=' + N);
console.log(
    pad('shape', 16) + ' ' + pad('n', 5) + ' ' + pad('moved(1)', 9) + ' ' +
    pad('oStores(2)', 11) + ' ' + pad('LIS', 5) + ' ' + pad('n-LIS(3)', 9) + ' ' +
    pad('redundant', 10) + ' ' + 'path',
);

let anyUnclassified = false;
let a1Pass = 0;
for (let s = 0; s < SHAPES.length; s++) {
    const name = SHAPES[s][0];
    const r = runShape(SHAPES[s][1]);
    if (!r.classified) anyUnclassified = true;
    if (r.classified && r.redundant / r.n >= 0.50) a1Pass++;
    console.log(
        pad(name, 16) + ' ' + pad(r.n, 5) + ' ' + pad(r.moved, 9) + ' ' +
        pad(r.classified ? r.oStores : '-', 11) + ' ' + pad(r.lis, 5) + ' ' +
        pad(r.nlis, 9) + ' ' + pad(r.redundant, 10) + ' ' + r.path,
    );
}

console.log('');
console.log('A-1 (redundant/n >= 0.50): ' + a1Pass + '/' + SHAPES.length + ' shapes' +
    (a1Pass >= 3 ? ' -- A-1 holds (>= 3)' : ' -- A-1 FAILS (< 3)'));

if (anyUnclassified) {
    console.error('bench: at least one shape did not classify as general/changed -- see path=UNCLASSIFIED.');
    process.exit(1);
}
