/**
 * T5 -- differential reconcile fuzz (the oracle), the gated descendant of
 * bench/torture/maparray-fuzzer.mjs.
 *
 * Same op mix (append / pop / prepend / insert / remove / swap / reverse /
 * value-churn) PLUS the T1 degenerate shapes injected into the stream (clear to
 * empty, a contained duplicate, single row), oracle-checked EVERY step through
 * validate() (Order + Identity + Index). The two things new here vs the bench:
 *
 *   - the registry is PRE-GROWN with `onCapacityExceeded:"throw"` (never "grow"),
 *     sized above the run's bounded high-water, so the pool NEVER grows -- and
 *     that is asserted: poolGrowths delta 0 over the whole run. On the bench's
 *     "grow" registry this property is structurally unobservable (M-02); here a
 *     pool-growth regression throws (CapacityError) or trips the delta gate.
 *   - the degenerate door is exercised, not just the happy path.
 *
 * T5 OWNS the LITEMAP_TORTURE_BREAK=t5 control: on one designated step it sets a
 * DIVERGENT array (a row dropped) while validating against the full model, so the
 * oracle's Order line fails with a T5: tag -- proving the differential gate bites.
 */

import {
    SEED, makePrng, check, breaking,
    makeRegistry, makeMapFn, makeByValueMapFn, makeValidator, isThrowRegistry,
} from './harness.mjs';

const SCALE = Math.max(1, Number(process.env.TORTURE_SCALE) || 1);
const ITERS = 5000 * SCALE;
const MAXLEN = 48;             // bounded so the pre-grown throw registry never overflows
const BREAK_STEP = 2500;       // the designated divergence step for the t5 control

export function run() {
    const reg = makeRegistry({ maxNodes: 1 << 12, maxLinks: 1 << 14, mode: 'throw' });
    const R = reg.R;
    const keyOf = (r) => r.id;

    check(isThrowRegistry(reg),
        () => 'T5: fuzz bound to a non-throw registry (mode=' + reg.mode + ') -- ' +
            'a grow registry cannot witness the pool-flat property the fuzz asserts');

    const sidBox = { n: 0 };
    const validator = makeValidator(R, keyOf);
    const rand = makePrng(SEED ^ 0xA11CE);
    const ri = (n) => rand() % n;

    let nextId = 0;
    const mkRow = () => ({ id: nextId++, v: ri(1000) });
    let model = [];
    for (let i = 0; i < 8; i++) model.push(mkRow());

    const src = R.signal(model.slice(), { equals: () => false });
    const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
    const stop = R.effect(() => { void mapped(); });
    validator.validate(mapped, model, 'T5: initial');

    const b0 = R.stats();
    const armed = breaking('t5');

    for (let i = 0; i < ITERS; i++) {
        // --- injected degenerate shapes (the T1 door under load) -------------
        if (i % 900 === 0 && i > 0) {                          // clear to empty
            for (const _o of model) void _o; model = [];
        } else if (i % 900 === 450 && model.length > 0 && model.length < MAXLEN) {
            model.splice(1, 0, { id: model[0].id, v: ri(1000) });   // contained duplicate
        } else {
            const op = ri(8);
            const n = model.length;
            if (op === 0 && n < MAXLEN) model.push(mkRow());
            else if (op === 1 && n) model.pop();
            else if (op === 2 && n < MAXLEN) model.unshift(mkRow());
            else if (op === 3 && n < MAXLEN) model.splice(ri(n + 1), 0, mkRow());
            else if (op === 4 && n) model.splice(ri(n), 1);
            else if (op === 5 && n > 1) { const a = ri(n), b = ri(n); const t = model[a]; model[a] = model[b]; model[b] = t; }
            else if (op === 6 && n) { const idx = ri(n); model[idx] = { id: model[idx].id, v: ri(1000) }; }
            else if (n > 1) { const a = ri(n), b = ri(n); const [lo, hi] = a < b ? [a, b] : [b, a]; model = model.slice(0, lo).concat(model.slice(lo, hi + 1).reverse(), model.slice(hi + 1)); }
        }

        if (armed && i === BREAK_STEP && model.length > 0) {
            // CONTROL: publish a DIVERGENT array (last row dropped) but validate
            // against the full model -> the Order line fails with a T5: tag.
            src.set(model.slice(0, model.length - 1));
        } else {
            src.set(model.slice());
        }
        validator.validate(mapped, model, 'T5: step ' + i);
    }

    const b1 = R.stats();
    // The differentiator vs the bench's "grow" registry: the pool never grew.
    const dGrow = b1.poolGrowths - b0.poolGrowths;
    check(dGrow === 0,
        () => 'T5: poolGrowths delta ' + dGrow + ' (expected 0) -- the pre-grown throw registry ' +
            'grew mid-fuzz; a "grow" registry would have hidden this');

    stop(); mapped.dispose(); R.dispose(src);
    validator.assertBase('T5');

    // ===== byValue differential lane ([1.3]) =================================
    // Same oracle (validate()), keyOf = reference identity: the item IS the key.
    // sid identity holds -- a reference present once maps to the SAME view across
    // every reconcile; duplicate objects are contained; -0 <-> 0 is not a change.
    // The invariant vs the accessor lane: parked === 0 forever (no free-list), so
    // the pool RECYCLES within its pre-grown capacity (poolGrowths delta 0) while
    // genuine inserts allocate (totalAllocations is expected to move, not asserted).
    {
        const bvKeyOf = (it) => it;
        const bvValidator = makeValidator(R, bvKeyOf, { maxPool: Infinity });
        const bvSid = { n: 0 };
        const rand2 = makePrng(SEED ^ 0xB0FFE);
        const ri2 = (m) => rand2() % m;
        let uid = 0;
        const mkObj = () => ({ uid: uid++ });

        // Scripted -0 vs 0 seam: SameValueZero collides -> not an item change.
        {
            const zsrc = R.signal([-0], { equals: () => false });
            const zmapped = reg.mapper.mapArray(zsrc, makeByValueMapFn(R, { n: 0 }), { byValue: true });
            const zstop = R.effect(() => { void zmapped(); });
            const z0 = zmapped()[0];
            zsrc.set([0]);
            check(zmapped()[0] === z0,
                () => 'T5: byValue -0 -> 0 rebuilt the slot (SameValueZero must not be an item change)');
            check(Object.is(zmapped()[0].item, -0),
                () => 'T5: byValue -0/0 view lost the SameValueZero representative');
            check(zmapped.stats().parked === 0, () => 'T5: byValue -0/0 parked ' + zmapped.stats().parked);
            zstop(); zmapped.dispose(); R.dispose(zsrc);
        }

        let bvModel = [];
        for (let i = 0; i < 6; i++) bvModel.push(mkObj());
        const bvSrc = R.signal(bvModel.slice(), { equals: () => false });
        const bvMapped = reg.mapper.mapArray(bvSrc, makeByValueMapFn(R, bvSid), { byValue: true });
        const bvStop = R.effect(() => { void bvMapped(); });
        bvValidator.validate(bvMapped, bvModel, 'T5 byValue initial');

        const BV_ITERS = 1500 * SCALE;
        const BV_MAX = 40;
        const bv0 = R.stats();
        for (let i = 0; i < BV_ITERS; i++) {
            const op = ri2(9);
            const n = bvModel.length;
            if (op === 0 && n < BV_MAX) bvModel.push(mkObj());                    // append
            else if (op === 1 && n) bvModel.pop();                               // pop
            else if (op === 2 && n < BV_MAX) bvModel.unshift(mkObj());           // prepend
            else if (op === 3 && n < BV_MAX) bvModel.splice(ri2(n + 1), 0, mkObj());  // middle insert
            else if (op === 4 && n) bvModel.splice(ri2(n), 1);                   // middle remove
            else if (op === 5 && n > 1) { const a = ri2(n), b = ri2(n); const t = bvModel[a]; bvModel[a] = bvModel[b]; bvModel[b] = t; }  // swap
            else if (op === 6 && n > 1) bvModel = bvModel.slice().reverse();     // reverse
            else if (op === 7 && n > 0 && n < BV_MAX) bvModel.splice(1, 0, bvModel[0]);  // duplicate object (same ref)
            else if (n > 1) { const a = ri2(n), b = ri2(n); const [lo, hi] = a < b ? [a, b] : [b, a]; bvModel = bvModel.slice(0, lo).concat(bvModel.slice(lo, hi + 1).reverse(), bvModel.slice(hi + 1)); }

            bvSrc.set(bvModel.slice());
            bvValidator.validate(bvMapped, bvModel, 'T5 byValue step ' + i);
            check(bvMapped.stats().parked === 0,
                () => 'T5 byValue step ' + i + ': parked=' + bvMapped.stats().parked + ' (invariant: 0, no free-list)');
        }
        const bv1 = R.stats();
        const bvGrow = bv1.poolGrowths - bv0.poolGrowths;
        check(bvGrow === 0,
            () => 'T5: byValue poolGrowths delta ' + bvGrow + ' (expected 0) -- churn recycled within the ' +
                'pre-grown pool; a "grow" registry would have hidden a genuine growth');

        bvStop(); bvMapped.dispose(); R.dispose(bvSrc);
        bvValidator.assertBase('T5 byValue');
    }
}
