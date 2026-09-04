/**
 * @zakkster/lite-map -- torture harness.
 *
 * The shared spine for the mandated gate (`node --expose-gc test/torture.mjs`):
 * the seed + PRNG, the fail-closed assertion helpers, the zero-GC rule set and
 * its `runOpsGate` wrapper, the isolated-registry factory (createMapper on a
 * PRE-GROWN `onCapacityExceeded:"throw"` registry -- never the default registry,
 * never "grow"), the tracking mapFn / sid oracle, the plain-array reconcile
 * oracle, key canonicalisation, and `validate(mapped, arr)` (Order / Identity /
 * Index / Pool). Every tier imports from here so the discipline lives in one
 * place:
 *
 *   - `check()` builds its message ONLY on failure -- a per-iteration template
 *     literal is itself an allocation that would pollute the T6 gate. Pass a thunk.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run sequentially,
 *     never nested. `runOpsGate` opens and closes a single window per call and
 *     uses `stabilize:'deep'` so `maxArrayBuffersGrowth` resolves.
 *   - Every gated tier binds createMapper(R) to an ISOLATED registry sized above
 *     the run's high-water and configured `onCapacityExceeded:"throw"`. A "grow"
 *     registry cannot report the pool growth the gate exists to catch (M-02); the
 *     alloc gate FAILS CLOSED when handed anything but a verified throw registry.
 *   - `controlTripped(report)` is `verdict === 'fail'`, not `!ok`: an inconclusive
 *     verdict is not proof a control tripped (three-state verdicts).
 *
 * ENV: LITEMAP_TORTURE_BREAK arms a tier's deliberately-broken control.
 * ENGINES: the package ships engines>=18; this dev-only gate additionally needs
 * Node 20+ (lite-leak's FinalizationRegistry). We do NOT raise package engines
 * for a devDep-only entry.
 *
 * PLANNED EXTENSIONS (registered here, non-failing, so the harness names what it
 * will grow -- see ROADMAP.md sec 4):
 *   - C1 (M-04): mapped.stats() upgrades validate()'s Pool line from the engine
 *     ledger to the exact { live, parked, highWater } line. See makeValidator.
 *   - C2 (M-03): a byValue mapArray variant of T5/T6 -- moves stay pool-flat, only
 *     genuine inserts pull from the pool.
 *   - C3 (M-01): the reorder index-signal floor probed in T6 (rotate-by-1 ==
 *     genuinely-moved) is the evidence the LIS milestone is already met at the
 *     reactive layer; C3 benches output-move cost against it.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createRegistry } from '@zakkster/lite-signal';
import { createMapper } from '../../Map.js';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

// ---- deliberately-broken control arming -----------------------------------
//
// Every gate must be provably able to fail. Each tier that owns a control reads
// `breaking(tier)` rather than a single global flag, so `controls.mjs` can arm
// ONE tier at a time and observe THAT tier trip for THAT tier's reason.
//
// LITEMAP_TORTURE_BREAK=1 (or `all`) arms the owning set; a comma list names
// specific tiers; empty/0 arms nothing.
const BREAK_RAW = (process.env.LITEMAP_TORTURE_BREAK || '').trim().toLowerCase();

/** True when any control is armed. Kept for the entry-point's final backstop. */
export const BREAK = BREAK_RAW !== '' && BREAK_RAW !== '0';

/**
 * Tiers that OWN an injectable control keyed to `breaking(tier)`. Arming one of
 * these alone MUST trip THAT tier, print its `TN:` tag, and exit non-zero.
 *
 * t1 and t9 own NO injectable control: t1 is a degenerate-input assertion tier,
 * and t9's controls run on EVERY invocation (they prove the gates bite in
 * process). Arming either exercises the entry-point BACKSTOP -- no tier trips, so
 * the run fails safe with the shared backstop message rather than printing "ok".
 */
export const CONTROL_OWNING_TIERS = ['t0', 't5', 't6', 't7'];

/** Every tier id nameable in LITEMAP_TORTURE_BREAK. controls.mjs walks all six;
 *  CONTROL_OWNING_TIERS decides which check each one gets. */
export const ALL_ARMABLE_TIERS = ['t0', 't1', 't5', 't6', 't7', 't9'];

/** The tiers whose controls this run has armed. `1`/`all` arms the owning set. */
export const BREAK_TIERS = BREAK_RAW === '1' || BREAK_RAW === 'all'
    ? CONTROL_OWNING_TIERS.slice()
    : BREAK_RAW.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Is this tier's deliberately-broken variant armed?
 * @param {string} tier lowercase tier id, e.g. 't6'
 */
export function breaking(tier) {
    return BREAK_TIERS.indexOf(tier) !== -1;
}

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`.
 *  No maxMinor: the reconcile hot path produces short-lived nursery churn from
 *  the profiler's own sampling; major==0 + pause + arrayBuffers is the contract. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** The distinct token a DEFEATED control emits. controls.mjs asserts it is ABSENT
 *  on a healthy run -- single source of truth so emitter and grep cannot drift. */
export const CONTROL_DEFEATED_TOKEN = 'CONTROL-DEFEATED';

/** The entry-point backstop message, printed when a control is armed but no tier
 *  trips. Shared so the driver greps the exact string, not a paraphrase. */
export const BACKSTOP_MESSAGE = 'LITEMAP_TORTURE_BREAK set but every control still passed';

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/**
 * A control was ARMED but the gate did NOT catch the injected fault -- the gate
 * is DEFEATED (e.g. a budget widened until nothing can trip it). Distinct from a
 * control that fired correctly; both exit non-zero, so the defeat token lets
 * controls.mjs tell a working gate from a broken one.
 * @param {string} msg
 */
export function controlDefeated(msg) {
    process.stderr.write('torture: ' + CONTROL_DEFEATED_TOKEN + ' -- ' + msg + '\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Fail-closed control assertion for a lite-gc-profiler report. lite-gc-profiler
 * has three verdicts and `report.ok` is `verdict === 'pass'`, so `!report.ok` is
 * reachable via BOTH `fail` and `inconclusive`. A control that only asserts
 * `!report.ok` cannot tell "the gate caught the injected allocation" (fail,
 * proof) from "the gate could not tell" (inconclusive, no proof). A control MUST
 * demand `verdict === 'fail'`.
 * @param {{verdict:string}} report
 * @returns {boolean} true only when the report is an unambiguous fail.
 */
export function controlTripped(report) {
    return report.verdict === 'fail';
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * `stabilize:'deep'` so `maxArrayBuffersGrowth` resolves (ArrayBuffer backing
 * stores live outside the V8 heap). Returns the checkNoGc report + raw summary.
 * @param {(i:number)=>void} fn      Sync hot body (must not allocate in the driver).
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

// ---- isolated registry factory --------------------------------------------
//
// Every gated tier binds to its OWN registry, never the default one. The mode is
// carried on the wrapper so the alloc gate can verify it fail-closed: null is not
// zero, and a registry whose capacity policy cannot be confirmed is rejected.

/**
 * @param {{maxNodes:number, maxLinks:number, mode:('throw'|'grow')}} cfg
 * @returns {{R:object, mapper:{mapArray:Function,indexArray:Function}, mode:string, maxNodes:number, maxLinks:number}}
 */
export function makeRegistry(cfg) {
    const R = createRegistry({
        maxNodes: cfg.maxNodes,
        maxLinks: cfg.maxLinks,
        prealloc: 'eager',
        onCapacityExceeded: cfg.mode,
    });
    return { R, mapper: createMapper(R), mode: cfg.mode, maxNodes: cfg.maxNodes, maxLinks: cfg.maxLinks };
}

/**
 * The alloc gate's fail-closed premise: the registry under measurement must be
 * "throw" mode. A "grow" registry silently absorbs the pool growth the gate
 * exists to catch (M-02), and the profiler's ArrayBuffer counter is blind to it.
 * A missing/untagged wrapper is rejected too (null is not zero).
 * @param {{mode?:string}} reg
 * @returns {boolean}
 */
export function isThrowRegistry(reg) {
    return reg != null && reg.mode === 'throw';
}

// ---- tracking mapFn / sid oracle -------------------------------------------
//
// Each created scope gets a unique sid kept across reuse, so sid-stability
// distinguishes MOVE (idxSig.set, same view) from REBUILD (fresh scope). item
// and index are tracked into a stable view object through effects the scope
// adopts. An optional idxRuns counter counts index-effect RERUNS (the M-01 floor
// probe): the increment is a property write on a pre-existing object -- zero
// allocation, safe inside a measured window.

/**
 * @param {object} R      isolated registry
 * @param {{n:number}} sidBox   monotonic sid source (mutated in place)
 * @param {{n:number}} [idxRuns] optional index-effect rerun counter
 */
export function makeMapFn(R, sidBox, idxRuns) {
    return (itemAcc, idxAcc) => {
        const idxIsAccessor = typeof idxAcc === 'function';
        const view = { item: itemAcc(), index: idxIsAccessor ? idxAcc() : idxAcc, sid: sidBox.n++ };
        R.effect(() => { view.item = itemAcc(); });
        if (idxIsAccessor) {
            R.effect(() => { view.index = idxAcc(); if (idxRuns !== undefined) idxRuns.n++; });
        }
        return view;
    };
}

// ---- key canonicalisation --------------------------------------------------
//
// The reconciler's byKey is a JS Map -> SameValueZero equality: NaN keys collide
// with each other, -0 collides with +0. The oracle and validator must mirror
// that, or an edge-key case would diverge for a spurious reason (NaN !== NaN
// under ===). canon() collapses a key to its SameValueZero identity for
// comparison and multiplicity counting.

const CANON_NAN = Symbol('canon:NaN');

/** Canonicalise a key to its Map (SameValueZero) identity. */
export function canon(k) {
    if (typeof k === 'number') {
        if (k !== k) return CANON_NAN;   // NaN
        if (k === 0) return 0;            // collapse -0 and +0
    }
    return k;
}

// ---- plain-array reconcile oracle ------------------------------------------

/**
 * The reference reconciler: the expected canonical key sequence of `arr`.
 * mapped() must, in order, key-match this.
 * @param {Array} arr
 * @param {(item:unknown)=>unknown} keyOf
 * @returns {Array} canonical keys in order
 */
export function oracle(arr, keyOf) {
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = canon(keyOf(arr[i]));
    return out;
}

// ---- validate(mapped, arr) -- Order / Identity / Index / Pool --------------
//
// O(state). Call it BETWEEN phases, never inside a measured window. The
// validator closes over the identity history and the isolated registry.
//
//   Order:    mapped() view keys, in order, equal keyOf(arr) in order.
//   Identity: a key unique in arr maps to the SAME view object as on the
//             previous reconcile where it was also unique. Carried through a
//             contained-duplicate episode (the byKey owner survives), dropped
//             when the key leaves the list.
//   Index:    every live slot i has its idxSig reading i (view.index === i,
//             observed through the mapFn index accessor -- internals are not
//             reachable).
//   Pool:     C0 SCOPE NOTE. mapped exposes only dispose() until C1's stats(), so
//             the exact { live, parked, highWater } line cannot be read yet. C0
//             asserts the pool line via the ENGINE ledger: activeNodes stays flat
//             at the settled high-water across churn (no leak, no double-count)
//             and returns to base after dispose(). C1 upgrades this to the exact
//             line once mapped.stats() exists (M-04).

/**
 * @param {object} R   isolated registry
 * @param {(item:unknown)=>unknown} keyOf
 */
export function makeValidator(R, keyOf) {
    const lastUniqueView = new Map();          // canonKey -> view (last reconcile where unique)
    const base = R.stats().activeNodes;        // ledger base BEFORE any build on this registry
    let highWater = base;                      // all-time peak activeNodes seen through validate()

    const keyOfView = (v) => keyOf(v.item);

    return {
        base,
        get highWater() { return highWater; },

        /** Forget the identity history. A soak tier that builds a FRESH mapper per
         *  cycle (T7) reuses the same keys with new scopes, so cross-cycle identity
         *  is legitimately not preserved; reset between mappers (base is kept, so
         *  assertBase still catches cross-cycle ledger drift). */
        resetIdentity() { lastUniqueView.clear(); },

        /** Assert the ledger returned to base -- every node the mappers took is
         *  back in the pool. Use after dispose(). This is the C0 Pool-conservation
         *  gate: a leaked scope leaves activeNodes above base. (T5/T6 add the
         *  stronger poolGrowths/totalAllocations zero-delta witness; T7 asserts
         *  this every cycle, so a drift is a per-cycle failure, not a final one.) */
        assertBase(label) {
            const now = R.stats().activeNodes;
            check(now === base, () => label + ': ledger did not return to base after dispose -- ' +
                'activeNodes=' + now + ' base=' + base + ' (retained ' + (now - base) + ' nodes)');
        },

        /**
         * Order + Identity + Index + Pool over one reconcile.
         * @param {() => Array} mapped
         * @param {Array} arr
         * @param {string} label
         */
        validate(mapped, arr, label) {
            const out = mapped();
            const n = arr.length;

            // Order (length + per-slot key match against the oracle).
            check(out.length === n, () => label + ': length ' + out.length + ' != ' + n);
            const expect = oracle(arr, keyOf);
            for (let i = 0; i < n; i++) {
                check(canon(keyOfView(out[i])) === expect[i],
                    () => label + ': order diverged at ' + i + ' -- got ' +
                        String(canon(keyOfView(out[i]))) + ' expected ' + String(expect[i]));
            }

            // Index (every live slot reads its own position through the accessor).
            for (let i = 0; i < n; i++) {
                check(out[i].index === i,
                    () => label + ': index at slot ' + i + ' reads ' + out[i].index + ' (expected ' + i + ')');
            }

            // Identity (unique-key survivors keep their view; contained dups carry).
            const mult = new Map();
            for (let i = 0; i < n; i++) {
                const k = canon(keyOf(arr[i]));
                mult.set(k, (mult.get(k) || 0) + 1);
            }
            const present = new Set();
            for (let i = 0; i < n; i++) {
                const k = canon(keyOf(arr[i]));
                present.add(k);
                if (mult.get(k) !== 1) continue;         // duplicate this round: skip, carry prior
                const v = out[i];
                if (lastUniqueView.has(k)) {
                    check(lastUniqueView.get(k) === v,
                        () => label + ': survivor key ' + String(k) + ' was REBUILT (identity lost) ' +
                            'instead of moved');
                }
                lastUniqueView.set(k, v);
            }
            // Drop keys that left the list; keep contained-dup keys (mult>1) so a
            // re-unique key still matches the byKey owner.
            for (const k of Array.from(lastUniqueView.keys())) {
                if (!present.has(k)) lastUniqueView.delete(k);
            }

            // Pool (ledger high-water tracking). Variable-length tiers grow the
            // ledger legitimately, so the per-step invariant is monotonic tracking,
            // not a fixed ceiling; the enforced conservation gate is assertBase()
            // after dispose (plus the tiers' zero-delta counters).
            const now = R.stats().activeNodes;
            if (now > highWater) highWater = now;
        },
    };
}

/**
 * The pure identity predicate behind validate()'s Identity line, exposed so the
 * T9 non-vacuity control can prove the gate FAILS on a real loss (not just passes
 * on a corpus that never loses one). Returns true iff every unique-key survivor
 * present in BOTH maps kept its exact view object.
 * @param {Map} prevUnique   canonKey -> view from the previous reconcile
 * @param {Array} out        current mapped() output
 * @param {Array} arr        current source array
 * @param {(item:unknown)=>unknown} keyOf
 * @returns {boolean}
 */
export function identityHolds(prevUnique, out, arr, keyOf) {
    const mult = new Map();
    for (let i = 0; i < arr.length; i++) {
        const k = canon(keyOf(arr[i]));
        mult.set(k, (mult.get(k) || 0) + 1);
    }
    for (let i = 0; i < arr.length; i++) {
        const k = canon(keyOf(arr[i]));
        if (mult.get(k) !== 1) continue;
        if (prevUnique.has(k) && prevUnique.get(k) !== out[i]) return false;
    }
    return true;
}
