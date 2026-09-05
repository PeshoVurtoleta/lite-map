/**
 * T0 -- metamorphic laws.
 *
 *   - oracle-equality: mapped() key-matches a plain-array oracle over a random,
 *     uniqueness-preserving op sequence (Order + Index every step).
 *   - idempotence: setting the identical array twice writes NO idxSig.set and
 *     touches the pool NOT AT ALL (idxRuns delta 0, ledger deltas 0).
 *   - survivor identity: a key that stays unique keeps its view object across
 *     every reconcile (validate()'s Identity line).
 *   - dispose leaves zero retained: the engine ledger returns to base.
 *
 * T0 OWNS the LITEMAP_TORTURE_BREAK=t0 control: it corrupts the idempotence law
 * (re-sets a ROTATED array while still asserting the no-write invariant) so a
 * real `check` fires with a T0: tag -- proving the idempotence gate can fail.
 */

import {
    SEED, makePrng, check, breaking,
    makeRegistry, makeMapFn, makeValidator,
} from './harness.mjs';

const KEYS = [];
for (let i = 0; i < 16; i++) KEYS.push('k' + i);

export function run() {
    const reg = makeRegistry({ maxNodes: 1 << 12, maxLinks: 1 << 14, mode: 'throw' });
    const R = reg.R;
    const keyOf = (it) => it.id;
    const sidBox = { n: 0 };
    const idxRuns = { n: 0 };
    const mapFn = makeMapFn(R, sidBox, idxRuns);
    const validator = makeValidator(R, keyOf);

    const rand = makePrng(SEED ^ 0x0757);
    const used = new Set();
    let ver = 0;
    let model = [];
    for (let i = 0; i < 5; i++) { const id = KEYS[i]; used.add(id); model.push({ id, v: ver++ }); }

    const src = R.signal(model.slice(), { equals: () => false });
    const mapped = reg.mapper.mapArray(src, mapFn, { key: keyOf });
    const stop = R.effect(() => { void mapped(); });
    validator.validate(mapped, model, 'T0 initial');

    // --- law: oracle-equality + survivor identity under random churn ---------
    for (let step = 0; step < 400; step++) {
        const r = rand() / 0xffffffff;
        const n = model.length;
        if (r < 0.22 && used.size < KEYS.length) {                 // insert unused key
            const avail = KEYS.filter((k) => !used.has(k));
            const id = avail[rand() % avail.length];
            used.add(id);
            model.splice(rand() % (n + 1), 0, { id, v: ver++ });
        } else if (r < 0.40 && n > 0) {                            // remove
            const idx = rand() % n; used.delete(model[idx].id); model.splice(idx, 1);
        } else if (r < 0.58 && n >= 2) {                           // move
            const from = rand() % n; const to = rand() % n;
            const [it] = model.splice(from, 1); model.splice(to, 0, it);
        } else if (r < 0.72) {                                     // reverse
            model.reverse();
        } else if (r < 0.86 && n >= 2) {                           // swap
            const i = rand() % n; const j = rand() % n;
            const t = model[i]; model[i] = model[j]; model[j] = t;
        } else if (r < 0.97 && n > 0) {                            // value-replace (same key)
            const idx = rand() % n; model[idx] = { id: model[idx].id, v: ver++ };
        } else {                                                   // clear
            for (const o of model) used.delete(o.id); model = [];
        }
        src.set(model.slice());
        validator.validate(mapped, model, 'T0 churn step ' + step);
    }

    // --- law: idempotence (set identical array twice is a no-op) -------------
    // Refill to a stable >=2-row shape (a rotate must genuinely move rows for the
    // t0 control to bite), settle, then re-set the SAME reference.
    while (model.length < 2) {
        const id = KEYS.find((k) => !used.has(k)) || KEYS[model.length];
        used.add(id); model.push({ id, v: ver++ });
    }
    const stable = model.slice();
    src.set(stable);
    validator.validate(mapped, stable, 'T0 pre-idempotence');

    const b0 = R.stats();
    idxRuns.n = 0;
    if (breaking('t0')) {
        // CONTROL: re-set a ROTATED array but assert the no-write invariant. The
        // rotate writes idxSig on every moved row, so the idxRuns===0 check below
        // fails with a T0: tag -- the idempotence gate demonstrably bites.
        const rotated = stable.slice(1).concat(stable[0]);
        src.set(rotated);
    } else {
        src.set(stable);           // identical reference: value-only path, no writes
    }
    const b1 = R.stats();
    check(idxRuns.n === 0,
        () => 'T0: idempotence violated -- re-setting the identical array wrote ' + idxRuns.n +
            ' idxSig.set (expected 0)');
    check(b1.totalAllocations - b0.totalAllocations === 0,
        () => 'T0: idempotence touched the pool -- totalAllocations delta ' +
            (b1.totalAllocations - b0.totalAllocations) + ' (expected 0)');
    check(b1.poolGrowths - b0.poolGrowths === 0,
        () => 'T0: idempotence grew the pool -- poolGrowths delta ' +
            (b1.poolGrowths - b0.poolGrowths) + ' (expected 0)');

    // --- law: stats() is a reused, frozen, live view -------------------------
    const st = mapped.stats();
    check(st === mapped.stats(), () => 'T0: stats() is not reference-stable across reads');
    check(Object.isFrozen(st), () => 'T0: stats() object is not frozen');
    check(typeof st.live === 'number' && typeof st.parked === 'number' && typeof st.highWater === 'number',
        () => 'T0: stats() fields are not all numbers');
    check(Object.keys(st).join(',') === 'live,parked,highWater',
        () => 'T0: stats() keys are [' + Object.keys(st).join(',') + '] (expected live,parked,highWater)');

    // Live-view freshness: the SAME object reports the new live after a mutation,
    // with NO second stats() call.
    const liveBefore = st.live;
    src.set(stable.slice(0, stable.length - 1));     // pop the tail row
    check(st.live === liveBefore - 1,
        () => 'T0: stats() is not a live view -- live=' + st.live + ' after a pop (expected ' +
            (liveBefore - 1) + ')');
    src.set(stable);                                 // restore
    const hwBefore = st.highWater;

    // --- law: dispose leaves zero retained + fact-6 post-dispose pin ----------
    stop();
    mapped.dispose();
    R.dispose(src);
    validator.assertBase('T0');
    check(mapped.stats() === st, () => 'T0: stats() reference changed after dispose');
    check(st.live === 0 && st.parked === 0,
        () => 'T0: post-dispose stats() not zeroed -- live=' + st.live + ' parked=' + st.parked);
    check(st.highWater === hwBefore,
        () => 'T0: post-dispose highWater=' + st.highWater + ' (expected historical ' + hwBefore + ')');
}
