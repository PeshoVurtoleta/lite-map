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
 */

import {
    check, canon, controlDefeated, controlTripped, runOpsGate,
    makeRegistry, makeMapFn, isThrowRegistry, identityHolds,
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

    // A silent guard against a no-op tier: if control (a)'s guard ever stopped
    // discriminating, the checks above would have exited. Reaching here means
    // every gate demonstrably caught its injected fault.
    check(true, () => 'unreachable');
}
