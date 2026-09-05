/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * Runs deliberately-broken variants IN PROCESS on EVERY invocation and asserts
 * the corresponding gate flags each one. A control PASSES (no exit) when its gate
 * correctly catches the injected fault; it emits CONTROL-DEFEATED and exits only
 * when a gate is BLIND -- a gate that cannot fail is decorative. This runs on a
 * plain `node --expose-gc test/torture.mjs`, so the gates are proven to bite
 * without the whole-suite LITEMAP_TORTURE_BREAK switch (which t0/t5/t6/t7 also
 * honour for an end-to-end non-zero exit).
 *
 * Controls (BRIEF task 3, tier T9):
 *   (a) a "grow" registry under the alloc gate MUST be REJECTED (fail-closed) --
 *       the M-02 trap made executable -- and the mode tags must be behaviourally
 *       honest (a throw registry throws on overflow, a grow one does not).
 *   (b) counter liveness under genuine growth -- proves totalAllocations is not
 *       stuck at zero: real new-scope allocation past the high-water (8 -> 40
 *       rows) must show delta > 0 through the SAME counter the real gate reads.
 *   (c) an identity-losing diff (a survivor handed a fresh scope): the NON-VACUITY
 *       control -- validate()'s Identity predicate must FAIL on a real loss.
 *   (d) a mapped() that allocates a new array per read: the reference-stability
 *       check must catch it.
 *   (e) an allocating value-churn loop: runOpsGate must return verdict 'fail'.
 *   (f) a fresh-object-per-read stats() variant: caught by reference-stability +
 *       frozenness, NOT the heap gate. RULES carries no maxMinor (harness :108-110),
 *       so a per-read plain object is nursery garbage the major/ArrayBuffer rules
 *       cannot see -- the heap-visible allocating loop is already control (e), not
 *       duplicated here (resolved risk (e)). The real stats() is === and frozen; the
 *       variant fails both.
 *   (g) a broken highWater (reset on shrink): rejected by highWaterMonotone in both
 *       directions, plus poolLineHolds proven to bite on a parked-over-cap line.
 */

import {
    check, canon, controlDefeated, controlTripped, runOpsGate,
    makeRegistry, makeMapFn, isThrowRegistry, identityHolds,
    poolLineHolds, highWaterMonotone,
} from './harness.mjs';

export function run() {
    const keyOf = (it) => it.id;

    // --- (a) grow registry rejected by the alloc gate's fail-closed guard ----
    {
        const grow = makeRegistry({ maxNodes: 64, maxLinks: 256, mode: 'grow' });
        const thrw = makeRegistry({ maxNodes: 64, maxLinks: 256, mode: 'throw' });
        if (isThrowRegistry(grow)) {
            controlDefeated('T9: the alloc-gate guard ACCEPTED a grow-mode registry (fail-open) -- ' +
                'it cannot report the pool growth the gate exists to catch');
        }
        if (!isThrowRegistry(thrw)) {
            controlDefeated('T9: the alloc-gate guard REJECTED a valid throw-mode registry');
        }
        // The mode tags must be behaviourally honest, or the guard gates on a lie.
        let thrwThrew = false;
        try { for (let i = 0; i < 500; i++) thrw.R.signal(i); } catch (e) { thrwThrew = true; }
        if (!thrwThrew) {
            controlDefeated('T9: a throw-mode registry did NOT throw on overflow -- the mode tag is dishonest');
        }
        let growThrew = false;
        try { for (let i = 0; i < 500; i++) grow.R.signal(i); } catch (e) { growThrew = true; }
        if (growThrew) {
            controlDefeated('T9: a grow-mode registry threw on overflow -- it would not hide growth as the trap claims');
        }
    }

    // --- (b) counter liveness under genuine growth (8 -> 40 rows): proves ----
    // --- totalAllocations is not stuck at zero, through the real gate's counter
    {
        const reg = makeRegistry({ maxNodes: 1 << 12, maxLinks: 1 << 14, mode: 'throw' });
        const R = reg.R;
        const sidBox = { n: 0 };
        const model = [];
        for (let i = 0; i < 8; i++) model.push({ id: i, v: 0 });
        const src = R.signal(model.slice(), { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });

        const b0 = R.stats();
        // Genuine growth past the high-water pulls NEW scopes from the pool -- the
        // exact allocation a rebuild-instead-of-reuse reconciler would show. The
        // real gate reads this same delta and demands 0; here it MUST read > 0, or
        // the counter is blind.
        for (let i = 8; i < 40; i++) model.push({ id: i, v: 0 });
        src.set(model.slice());
        const b1 = R.stats();

        if (!(b1.totalAllocations - b0.totalAllocations > 0)) {
            controlDefeated('T9: the totalAllocations gate is BLIND -- genuine new-scope allocation ' +
                'read as delta ' + (b1.totalAllocations - b0.totalAllocations) + ' (expected > 0)');
        }
        stop(); mapped.dispose(); R.dispose(src);
    }

    // --- (c) identity-losing diff: the NON-VACUITY control -------------------
    {
        const prev = new Map();
        const survivorView = { item: { id: 'a' }, index: 0 };
        prev.set(canon('a'), survivorView);
        const arr = [{ id: 'a' }];

        // The gate must PASS on a preserved survivor...
        if (!identityHolds(prev, [survivorView], arr, keyOf)) {
            controlDefeated('T9: the identity gate false-positived on a preserved survivor');
        }
        // ...and FAIL when the same key is handed a REBUILT (fresh) view.
        const freshView = { item: { id: 'a' }, index: 0 };
        if (identityHolds(prev, [freshView], arr, keyOf)) {
            controlDefeated('T9: the identity gate MISSED a real identity loss -- a survivor handed a ' +
                'fresh scope passed the Identity line (vacuous gate)');
        }
    }

    // --- (d) per-read array allocation: the reference-stability check bites ---
    {
        const stable = [];
        const stableFn = () => stable;
        if (stableFn() !== stableFn()) {
            controlDefeated('T9: the reference-stability check false-negatived on a stable array');
        }
        const perRead = () => [];   // a hostile mapped() that allocates per read
        if (perRead() === perRead()) {
            controlDefeated('T9: the reference-stability check MISSED a per-read array allocation');
        }
    }

    // --- (e) allocating loop: runOpsGate returns verdict 'fail' ---------------
    {
        const sink = [];
        const { report } = runOpsGate(() => { sink.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
        if (!controlTripped(report)) {
            controlDefeated('T9: the alloc gate did not fail on an allocating loop (verdict=' +
                report.verdict + ', ok=' + report.ok + ')');
        }
        sink.length = 0;
    }

    // --- (f) allocating stats() variant: reference-stability + frozenness bite -
    // A per-read stats() is nursery garbage the heap gate cannot see (RULES has no
    // maxMinor -- risk e); the gate that genuinely catches it is === + isFrozen.
    {
        const reg = makeRegistry({ maxNodes: 1 << 10, maxLinks: 1 << 12, mode: 'throw' });
        const R = reg.R;
        const sidBox = { n: 0 };
        const src = R.signal([{ id: 'a' }, { id: 'b' }], { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });

        // The real surface: ONE reused frozen object.
        if (mapped.stats() !== mapped.stats()) {
            controlDefeated('T9: the real stats() is not reference-stable -- the frozen-live-view invariant broke');
        }
        if (!Object.isFrozen(mapped.stats())) {
            controlDefeated('T9: the real stats() object is not frozen');
        }
        // The hostile variant: a fresh plain object per read. It MUST fail BOTH the
        // reference-stability and the frozenness discriminators.
        const perRead = () => ({ live: 0, parked: 0, highWater: 0 });
        if (perRead() === perRead()) {
            controlDefeated('T9: the stats reference-stability check MISSED a per-read allocating stats()');
        }
        if (Object.isFrozen(perRead())) {
            controlDefeated('T9: the frozenness check accepted an unfrozen per-read stats object');
        }
        stop(); mapped.dispose(); R.dispose(src);
    }

    // --- (g) broken highWater: the monotone predicate + poolLineHolds bite ------
    {
        // highWaterMonotone must be non-vacuous: rising/flat pass, a reset-on-shrink
        // FALLS -- proven in both directions.
        if (!highWaterMonotone(7, 7) || !highWaterMonotone(7, 9)) {
            controlDefeated('T9: highWaterMonotone false-negatived a non-decreasing highWater (7->7 / 7->9)');
        }
        if (highWaterMonotone(9, 7)) {
            controlDefeated('T9: highWaterMonotone MISSED a reset-on-shrink regression (9->7 accepted)');
        }

        // The live half: a real mapper grown to 20 then shrunk to 5 keeps its peak
        // (highWater >= 20), and the predicate REJECTS a highWater recomputed to the
        // current live count (5) -- exactly the bug a recomputed counter would show.
        const reg = makeRegistry({ maxNodes: 1 << 10, maxLinks: 1 << 12, mode: 'throw' });
        const R = reg.R;
        const sidBox = { n: 0 };
        const rows = []; for (let i = 0; i < 20; i++) rows.push({ id: 'r' + i });
        const src = R.signal(rows.slice(), { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });
        src.set(rows.slice(0, 5));                     // shrink to 5
        const st = mapped.stats();
        if (!(st.highWater >= 20)) {
            controlDefeated('T9: a shrunk mapper reported highWater=' + st.highWater +
                ' (< 20) -- the all-time peak was not retained');
        }
        if (highWaterMonotone(st.highWater, st.live)) {
            controlDefeated('T9: highWaterMonotone accepted a highWater recomputed to the live count (' +
                st.live + ' < ' + st.highWater + ') -- a shrink would silently lower the peak');
        }
        stop(); mapped.dispose(); R.dispose(src);

        // poolLineHolds must bite too: PASS a conforming line, FAIL when parked
        // exceeds the cap. cap 0 is a RAW predicate probe only -- never a real
        // mapper (a real maxPool:0 reads as Infinity, fact 7).
        if (!poolLineHolds({ live: 3, parked: 1, highWater: 4 }, 3, 4)) {
            controlDefeated('T9: poolLineHolds false-negatived a conforming Pool line');
        }
        if (poolLineHolds({ live: 3, parked: 1, highWater: 4 }, 3, 0)) {
            controlDefeated('T9: poolLineHolds accepted parked=1 over cap 0 -- the cap check is vacuous');
        }
    }

    // A silent guard against a no-op tier: if control (a)'s guard ever stopped
    // discriminating, the checks above would have exited. Reaching here means
    // every gate demonstrably caught its injected fault.
    check(true, () => 'unreachable');
}
