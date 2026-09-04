/**
 * T6 -- the zero-alloc gate. THE tier for this package.
 *
 * Two phases, STRICTLY SEQUENTIAL (lite-gc-profiler is one-measurement-at-a-time):
 *
 *   (1) the alloc window. A mixed append/pop/reorder/value-churn/warm
 *       insert-remove hot body over a mapper bound to an ISOLATED registry
 *       PRE-GROWN to the run's high-water and `onCapacityExceeded:"throw"`. Two
 *       independent witnesses over the SAME window: the engine ledger
 *       (poolGrowths AND totalAllocations deltas both 0) and the lite-gc-profiler
 *       report (maxMajor 0, maxPauseMs <= 4, maxArrayBuffersGrowth 0,
 *       stabilize:'deep' -- verdict must be an unambiguous PASS).
 *
 *   (2) the structural floor the heap gate cannot make: a 1000-row rotate-by-1
 *       writes EXACTLY `genuinely-moved` idxSig.set calls (== 1000, M-01's floor,
 *       counted through the mapFn index effect); an adjacent mid-list swap writes
 *       exactly 2; and mapped() hands back the SAME array reference across reads.
 *
 * FAIL-CLOSED: the alloc window refuses to open on a registry that is not
 * verified "throw" mode (the M-02 trap made executable) -- a "grow" registry
 * absorbs the growth the gate exists to catch.
 *
 * HOT-BODY DISCIPLINE (sharp edges, load-bearing for the deltas to read 0):
 *   - the source signal uses `equals:()=>false` so set(sameRef) always reconciles;
 *   - ONE persistent model array is mutated IN PLACE (rotate = save head, shift
 *     left, place at tail; value churn = swap between two pre-built variants per
 *     key; insert/remove = push/pop a single pre-allocated spare, warmed into the
 *     free-list before the window);
 *   - all shape state is pre-allocated OUTSIDE the measured window; the hot body
 *     allocates nothing and its messages are thunks.
 *
 * T6 OWNS the LITEMAP_TORTURE_BREAK=t6 control: it retains a Float64Array in the
 * hot body, whose ArrayBuffer backing store trips maxArrayBuffersGrowth and
 * forces verdict=fail. A gate that cannot fail is decorative.
 */

import {
    check, die, breaking, controlTripped, controlDefeated,
    makeRegistry, makeMapFn, makeValidator, isThrowRegistry, runOpsGate,
} from './harness.mjs';

const N = 500;              // steady list length (high-water bar the churn stays under)
const OPS = 20000;
const WARMUP = 2000;
const FLOOR_N = 1000;      // rotate-by-1 floor probe size

/** Retained sink for the t6 control -- survives GC so arrayBuffers grows. */
const leak = [];

export function run() {
    let gcMetrics = { major: 0, minor: 0, maxMs: 0 };

    // ===== phase 1: the alloc window =========================================
    {
        const reg = makeRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, mode: 'throw' });
        const R = reg.R;
        const keyOf = (r) => r.id;
        const sidBox = { n: 0 };
        const idxRuns = { n: 0 };
        const mapFn = makeMapFn(R, sidBox, idxRuns);
        const validator = makeValidator(R, keyOf);

        // FAIL-CLOSED: only a verified throw registry may be measured.
        check(isThrowRegistry(reg),
            () => 'T6: alloc window opened on a non-throw registry (mode=' + reg.mode + ') -- ' +
                'a grow registry cannot report the growth the gate exists to catch');

        // Pre-allocated shape state (all OUTSIDE the measured window).
        const variantsA = new Array(N);
        const variantsB = new Array(N);
        for (let i = 0; i < N; i++) { variantsA[i] = { id: i, v: 0 }; variantsB[i] = { id: i, v: 1 }; }
        const spare = { id: 1000000, v: 0 };
        const model = variantsA.slice();

        const src = R.signal(model, { equals: () => false });
        const mapped = reg.mapper.mapArray(src, mapFn, { key: keyOf });
        const stop = R.effect(() => { void mapped(); });

        // PREGROW: drive one full reconcile at the run's high-water (base + spare),
        // then pop the spare so its slot is parked in the free-list. The measured
        // window's push/pop reuses that parked slot -- never allocating.
        model.push(spare); src.set(model);
        validator.validate(mapped, model, 'T6 pregrow high-water');
        model.pop(); src.set(model);
        validator.validate(mapped, model, 'T6 pregrow settled');

        // The hot body: mixed ops, in-place, zero allocation in the driver. The
        // control retains a Float64Array so its ArrayBuffer growth trips the gate.
        const armed = breaking('t6');
        const hot = (i) => {
            const op = i & 3;
            if (op === 0) {                              // rotate-by-1 in place (reorder)
                const h = model[0];
                for (let k = 1; k < model.length; k++) model[k - 1] = model[k];
                model[model.length - 1] = h;
                src.set(model);
            } else if (op === 1) {                       // value churn (same key, new object)
                const pos = i % model.length;            // key by id, not position: rotation
                const id = model[pos].id;                // has decoupled position from id
                model[pos] = model[pos] === variantsA[id] ? variantsB[id] : variantsA[id];
                src.set(model);
            } else if (op === 2) {                       // warm insert (reuse parked spare)
                model.push(spare);
                src.set(model);
            } else {                                     // warm remove (park the spare)
                model.pop();
                src.set(model);
            }
            if (armed) leak.push(new Float64Array(64));  // control: retained growth
        };

        // Manual warm so ICs, effects and the parked slot are all settled BEFORE
        // the snapshot/window opens; the window then measures a pure steady state.
        for (let i = 0; i < WARMUP; i++) hot(i);

        const b0 = R.stats();
        const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: 0 });
        const b1 = R.stats();

        // Structural conservation the heap gate does not make for us.
        check(model.length === N, () => 'T6: hot body left model length ' + model.length + ' (expected ' + N + ')');
        validator.validate(mapped, model, 'T6 post-window');

        if (armed) {
            // The injected ArrayBuffers MUST trip the gate as an unambiguous fail.
            // `!report.ok` would accept an inconclusive verdict as proof -- not proof.
            if (!controlTripped(report)) {
                controlDefeated('T6: control armed but verdict=' + report.verdict +
                    ' (expected "fail"); the alloc gate did not catch the injected ArrayBuffer growth');
            }
            die('T6: control tripped the alloc gate with verdict=fail (expected non-zero exit)');
        }

        // Witness 1 (engine ledger): both deltas exactly zero.
        const dGrow = b1.poolGrowths - b0.poolGrowths;
        const dAlloc = b1.totalAllocations - b0.totalAllocations;
        check(dGrow === 0, () => 'T6: poolGrowths delta ' + dGrow + ' (expected 0) -- the reconcile grew the pool');
        check(dAlloc === 0, () => 'T6: totalAllocations delta ' + dAlloc + ' (expected 0) -- the reconcile allocated nodes');

        // Witness 2 (heap): an unambiguous PASS, never inconclusive.
        if (report.verdict !== 'pass') {
            const g = summary.gc;
            die('T6 alloc gate verdict=' + report.verdict + ' (expected "pass") -- source=' + summary.source +
                ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
                ' abGrowth=' + summary.arrayBuffers.growthBytes + ' abSettled=' + summary.arrayBuffers.settled);
        }
        gcMetrics = { major: summary.gc.major, minor: summary.gc.minor, maxMs: summary.gc.maxMs };

        stop(); mapped.dispose(); R.dispose(src);
        validator.assertBase('T6 alloc');
    }

    // ===== phase 2: the M-01 index-signal floor (structural) =================
    {
        const reg = makeRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, mode: 'throw' });
        const R = reg.R;
        const keyOf = (r) => r.id;
        const sidBox = { n: 0 };
        const idxRuns = { n: 0 };
        const mapFn = makeMapFn(R, sidBox, idxRuns);

        const model = new Array(FLOOR_N);
        for (let i = 0; i < FLOOR_N; i++) model[i] = { id: i, v: 0 };
        const src = R.signal(model.slice(), { equals: () => false });
        const mapped = reg.mapper.mapArray(src, mapFn, { key: keyOf });
        const stop = R.effect(() => { void mapped(); });

        // mapped() reference stability: the output is one persistent, mutated array.
        check(mapped() === mapped(), () => 'T6: mapped() handed back a fresh array across reads');

        // rotate-by-1: every row's index changes -> exactly FLOOR_N idxSig.set.
        idxRuns.n = 0;
        const head = model[0];
        for (let k = 1; k < FLOOR_N; k++) model[k - 1] = model[k];
        model[FLOOR_N - 1] = head;
        src.set(model.slice());
        check(idxRuns.n === FLOOR_N,
            () => 'T6: rotate-by-1 wrote ' + idxRuns.n + ' idxSig.set (expected exactly ' + FLOOR_N +
                ' -- the genuinely-moved floor, M-01)');

        // adjacent mid-list swap: exactly two rows change index.
        idxRuns.n = 0;
        const mid = FLOOR_N >> 1;
        const t = model[mid]; model[mid] = model[mid + 1]; model[mid + 1] = t;
        src.set(model.slice());
        check(idxRuns.n === 2,
            () => 'T6: adjacent swap wrote ' + idxRuns.n + ' idxSig.set (expected exactly 2)');

        // still one persistent array after the reorders.
        check(mapped() === mapped(), () => 'T6: mapped() reference not stable after reorder');

        stop(); mapped.dispose(); R.dispose(src);
    }

    return { gc: gcMetrics };
}
