/**
 * T1 -- degenerate inputs. One case per shape, PINNING the decided policy.
 *
 *   edge keys      undefined / null / NaN / -0-vs-0 / 1-vs-"1": each distinct
 *                  canonical key renders once and in order; -0 and 0 collide
 *                  (SameValueZero, like the reconciler's byKey Map) and are a
 *                  contained duplicate.
 *   duplicates     a duplicate key renders in order and NEVER costs a unique key
 *                  its scope; the damage does not outlive the dupe; dispose leaks
 *                  nothing (ledger returns to base).
 *   empty/single   [] and single-row transitions round-trip.
 *   throwing keyOf PROPAGATES; the reconciler stays consistent (last-good state
 *                  readable) and recovers on the next clean set.
 *   bad source     a non-array / null source THROWS at the door (TypeError); the
 *                  previous mapped() state is intact, never half-applied.
 *
 * T1 owns NO injectable control (a pure assertion tier). Arming it exercises the
 * entry-point BACKSTOP -- proof that arming a control-less tier fails safe.
 */

import {
    check, canon,
    makeRegistry, makeMapFn, makeValidator,
} from './harness.mjs';

const ids = (mapped) => mapped().map((v) => v.item.id);

export function run() {
    const reg = makeRegistry({ maxNodes: 1 << 12, maxLinks: 1 << 14, mode: 'throw' });
    const R = reg.R;
    const keyOf = (it) => it.id;
    const sidBox = { n: 0 };

    // --- edge-case key values -------------------------------------------------
    {
        const validator = makeValidator(R, keyOf);
        const rows = [
            { id: undefined }, { id: null }, { id: NaN },
            { id: 1 }, { id: '1' }, { id: true }, { id: 0 },
        ];
        const src = R.signal(rows.slice(), { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });
        validator.validate(mapped, rows, 'T1 edge-keys initial');

        // Reorder: every distinct-canonical-key survivor keeps its view.
        const rev = rows.slice().reverse();
        src.set(rev);
        validator.validate(mapped, rev, 'T1 edge-keys reversed');

        // -0 vs 0 collide under SameValueZero: a two-row list of both is a
        // contained duplicate, not two slots by identity.
        check(canon(-0) === canon(0), () => 'T1: canon(-0) !== canon(0) -- SameValueZero mismatch');

        stop(); mapped.dispose(); R.dispose(src);
        validator.assertBase('T1 edge-keys');
    }

    // --- contained duplicate keys --------------------------------------------
    {
        const validator = makeValidator(R, keyOf);
        const A = { id: 'x', v: 1 }, B = { id: 'x', v: 2 }, C = { id: 'y', v: 3 };
        const src = R.signal([A, C], { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });

        // Capture the unique 'x' owner's view before the dupe arrives. It must
        // keep its scope for as long as it stays present -- a contained duplicate
        // never evicts the key's legitimate owner (the byKey-fix property).
        const xViewBefore = mapped()[0];
        check(ids(mapped).join(',') === 'x,y', () => 'T1: dup initial order wrong ' + ids(mapped));

        src.set([A, B, C]);                                  // dupe 'x' contained
        check(ids(mapped).join(',') === 'x,x,y', () => 'T1: dup render order wrong ' + ids(mapped));
        check(mapped()[0].sid === xViewBefore.sid,
            () => 'T1: a contained duplicate evicted the unique key owner (sid changed on arrival)');

        src.set([A, C]);                                     // drop the dupe only; A stays
        check(ids(mapped).join(',') === 'x,y', () => 'T1: dup drop wrong ' + ids(mapped));
        check(mapped()[0].sid === xViewBefore.sid,
            () => 'T1: the owner lost its scope after the contained duplicate left (sid changed)');

        src.set([C]);                                        // now fully drop x
        check(ids(mapped).join(',') === 'y', () => 'T1: post-dup drop wrong ' + ids(mapped));

        stop(); mapped.dispose(); R.dispose(src);
        validator.assertBase('T1 duplicates');   // no leak from the extra dup scope
    }

    // --- empty / single transitions ------------------------------------------
    {
        const validator = makeValidator(R, keyOf);
        const mk = (id) => ({ id });
        const src = R.signal([mk('a'), mk('b'), mk('c')], { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });
        const seq = [[], [mk('p')], [], [mk('s'), mk('t')], [mk('s')], []];
        for (let i = 0; i < seq.length; i++) {
            src.set(seq[i]);
            validator.validate(mapped, seq[i], 'T1 empty/single step ' + i);
        }
        stop(); mapped.dispose(); R.dispose(src);
        validator.assertBase('T1 empty/single');
    }

    // --- stats() degenerate shapes (T1 pins the read surface) -----------------
    {
        // never-populated mapArray -> { 0, 0, 0 }; single row -> { 1, 0, 1 };
        // post-dispose keeps the historical highWater (fact 6).
        const src = R.signal([], { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });
        const s = mapped.stats();
        check(s.live === 0 && s.parked === 0 && s.highWater === 0,
            () => 'T1: never-populated stats() = {' + s.live + ',' + s.parked + ',' + s.highWater +
                '} (expected 0,0,0)');
        src.set([{ id: 'solo' }]);
        check(s.live === 1 && s.parked === 0 && s.highWater === 1,
            () => 'T1: single-row stats() = {' + s.live + ',' + s.parked + ',' + s.highWater +
                '} (expected 1,0,1)');
        stop(); mapped.dispose(); R.dispose(src);
        check(s.live === 0 && s.parked === 0 && s.highWater === 1,
            () => 'T1: post-dispose stats() = {' + s.live + ',' + s.parked + ',' + s.highWater +
                '} (expected 0,0,1 -- highWater historical)');
    }

    // --- maxPool:0 documented behavior (fact 7): 0 is falsy -> UNSET ----------
    {
        // Park 5 rows under maxPool:0. 0 is falsy, so the pool is unbounded and all
        // 5 stay parked (NOT capped at 0). Pinned as a test so a future fix is a
        // deliberate breaking change, not a surprise.
        const rows = [];
        for (let i = 0; i < 5; i++) rows.push({ id: 'm' + i });
        const src = R.signal(rows.slice(), { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf, maxPool: 0 });
        const stop = R.effect(() => { void mapped(); });
        src.set([]);                                   // pop all 5 to the free-list
        const s = mapped.stats();
        check(s.live === 0 && s.parked === 5,
            () => 'T1: maxPool:0 capped the pool -- parked=' + s.parked +
                ' (expected 5; 0 is falsy -> unbounded, fact 7)');
        check(s.highWater === 5, () => 'T1: maxPool:0 highWater=' + s.highWater + ' (expected 5)');
        stop(); mapped.dispose(); R.dispose(src);
    }

    // --- indexArray stats(): both primitives are pinned in T1 ----------------
    {
        const list = R.signal([10, 20, 30], { equals: () => false });
        const mapped = reg.mapper.indexArray(list, (item, i) => ({ v: item(), i }));
        const stop = R.effect(() => { void mapped(); });
        const s = mapped.stats();
        check(s.live === 3 && s.parked === 0 && s.highWater === 3,
            () => 'T1: indexArray stats() = {' + s.live + ',' + s.parked + ',' + s.highWater +
                '} (expected 3,0,3)');
        list.set([10, 20]);                            // shrink: park one tail slot
        check(s.live === 2 && s.parked === 1 && s.highWater === 3,
            () => 'T1: indexArray after shrink = {' + s.live + ',' + s.parked + ',' + s.highWater +
                '} (expected 2,1,3)');
        stop(); mapped.dispose(); R.dispose(list);
        check(s.live === 0 && s.parked === 0 && s.highWater === 3,
            () => 'T1: indexArray post-dispose = {' + s.live + ',' + s.parked + ',' + s.highWater +
                '} (expected 0,0,3)');
    }

    // --- throwing keyOf propagates, state consistent -------------------------
    {
        const poison = { id: 7, bad: false };
        const throwingKey = (it) => { if (it.bad) throw new Error('T1-boom'); return it.id; };
        const src = R.signal([{ id: 5 }, poison, { id: 9 }], { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: throwingKey });
        const stop = R.effect(() => { void mapped(); });
        const before = ids(mapped).join(',');
        check(before === '5,7,9', () => 'T1: throwing-keyOf pre-state wrong ' + before);

        poison.bad = true;
        let threw = false;
        try { src.set([{ id: 5 }, poison, { id: 9 }]); } catch (e) { threw = true; }
        check(threw, () => 'T1: a throwing keyOf did NOT propagate (silently swallowed)');
        check(ids(mapped).join(',') === '5,7,9',
            () => 'T1: state was half-applied after a throwing keyOf -- ' + ids(mapped));

        poison.bad = false;
        src.set([{ id: 5 }, { id: 9 }]);                     // recovers cleanly
        check(ids(mapped).join(',') === '5,9', () => 'T1: reconciler did not recover ' + ids(mapped));

        stop(); mapped.dispose(); R.dispose(src);
    }

    // --- non-array / null source throws at the door --------------------------
    {
        const src = R.signal([{ id: 1 }], { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf });
        const stop = R.effect(() => { void mapped(); });

        let threwNull = false;
        try { src.set(null); } catch (e) { threwNull = e instanceof TypeError; }
        check(threwNull, () => 'T1: a null source did not throw a TypeError at the door');
        check(ids(mapped).join(',') === '1', () => 'T1: null source left half-applied state ' + ids(mapped));

        let threwNum = false;
        try { src.set(42); } catch (e) { threwNum = e instanceof TypeError; }
        check(threwNum, () => 'T1: a non-array (number) source did not throw a TypeError');

        stop(); mapped.dispose(); R.dispose(src);
    }
}
