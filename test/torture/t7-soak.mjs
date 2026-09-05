/**
 * T7 -- soak, retention, conservation.
 *
 * leak_cycles = 4096 build / churn / dispose cycles on ONE isolated registry.
 * After every cycle: validate() passes and dispose() returns the engine ledger to
 * base (activeNodes back to where it started -- no drift, no leak). The parked
 * population is bounded by maxPool, so the ledger high-water is bounded, not
 * growing by accident.
 *
 * The SECOND, independent retention witness (a lite-leak createLeakTracker,
 * distinct from the engine ledger): each cycle tracks that cycle's last item
 * object. The mapFn's item effect reads itemSig, which holds the item -- so a
 * scope that OUTLIVES dispose() keeps its item reachable, the FinalizationRegistry
 * never fires, and tracker.size() never drains. After the loop, drop every ref
 * and run settle passes (gc + macrotask yield, OUTSIDE any measured window per the
 * one-measurement-at-a-time rule); a clean run drains size() to 0 with zero
 * findings. HELD-VALUE CONTRACT: neither the cleanup (`() => {}`) nor the tag (a
 * string) closes over the tracked item, or finalization would be defeated and the
 * witness would silently report clean.
 *
 * T7 OWNS the LITEMAP_TORTURE_BREAK=t7 control: it RETAINS one tracked item in a
 * module-level sink (an external ref, not via cleanup/tag), so the FR never fires,
 * size() stays non-zero, and the witness fails with a T7: tag -- proving the
 * retention gate bites.
 *
 * lite-leak documents Node 20+ (FinalizationRegistry). This is a dev-only entry;
 * package engines stays >=18 (see harness header).
 */

import {
    check, breaking,
    makeRegistry, makeMapFn, makeByValueMapFn, makeValidator,
} from './harness.mjs';
import { createLeakTracker, createOwnerCascadeOrphanKernel } from '@zakkster/lite-leak';

const CYCLES = 4096;
const ROWS = 12;
const MAXPOOL = 16;

/** External retention sink for the t7 control -- holds a tracked item so its FR
 *  never fires. Does NOT close over anything the tracker retains internally. */
const held = [];

export async function run() {
    const reg = makeRegistry({ maxNodes: 1 << 12, maxLinks: 1 << 14, mode: 'throw' });
    const R = reg.R;
    const keyOf = (it) => it.id;
    const sidBox = { n: 0 };
    const validator = makeValidator(R, keyOf, { maxPool: MAXPOOL });

    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-map-soak',
        onLeak: (r) => leaks.push(r.kind + ':' + String(r.tag)),
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });
    tracker.registerKernel(createOwnerCascadeOrphanKernel());

    const armed = breaking('t7');

    for (let c = 0; c < CYCLES; c++) {
        // Fresh per-cycle items so a surviving scope keeps its item reachable.
        const items = new Array(ROWS);
        for (let k = 0; k < ROWS; k++) items[k] = { id: k, v: c };

        const src = R.signal(items.slice(), { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeMapFn(R, sidBox), { key: keyOf, maxPool: MAXPOOL });
        const stop = R.effect(() => { void mapped(); });

        // Churn: reverse, rotate, value-churn -- every key survives, all move.
        src.set(items.slice().reverse());
        src.set(items.slice(1).concat(items[0]));
        const churned = items.slice();
        churned[3] = { id: items[3].id, v: c + 1 };
        src.set(churned);
        src.set(items.slice());
        validator.resetIdentity();   // fresh mapper each cycle: no cross-cycle identity
        validator.validate(mapped, items, 'T7 cycle ' + c);

        // Per-cycle stats() conservation (C1): the reused frozen live view reports
        // the settled population. Integer comparisons on ONE pre-frozen object --
        // no per-cycle allocation added to the 4096-iteration loop. Captured now so
        // the post-dispose pin can prove highWater is historical (survives dispose).
        const st = mapped.stats();
        check(st.live === ROWS,
            () => 'T7 cycle ' + c + ': stats live=' + st.live + ' (expected ' + ROWS + ')');
        check(st.parked <= MAXPOOL,
            () => 'T7 cycle ' + c + ': stats parked=' + st.parked + ' > maxPool ' + MAXPOOL);
        check(st.live + st.parked <= st.highWater,
            () => 'T7 cycle ' + c + ': live+parked ' + (st.live + st.parked) +
                ' > highWater ' + st.highWater);
        const hwBefore = st.highWater;

        // The retention witness: track this cycle's last item. Neither cleanup nor
        // tag closes over it. Under the control, retain it externally so the FR
        // cannot fire and size() cannot drain.
        const witnessItem = items[ROWS - 1];
        tracker.track(witnessItem, () => {}, 'cycle#' + c);
        if (armed) held.push(witnessItem);

        stop();
        mapped.dispose();
        R.dispose(src);
        // Post-dispose stats pin (fact 6): live/parked zeroed, highWater historical
        // (unchanged from the pre-dispose read). Same reused object, no throw.
        check(st.live === 0 && st.parked === 0,
            () => 'T7 cycle ' + c + ': post-dispose stats not zeroed -- live=' + st.live +
                ' parked=' + st.parked);
        check(st.highWater === hwBefore,
            () => 'T7 cycle ' + c + ': post-dispose highWater=' + st.highWater +
                ' (expected historical ' + hwBefore + ')');
        // Ledger conservation: every node the mappers took is back in the pool,
        // and the pool did not drift up (parked bounded by maxPool).
        validator.assertBase('T7 cycle ' + c);
    }

    // ---- byValue soak ([1.3]): same retention + conservation discipline -------
    // A byValue view bakes the plain item, so a scope that outlives dispose() keeps
    // its item reachable exactly as the accessor itemSig does -- the same lite-leak
    // witness applies. Pure moves (reverse/rotate) never build; one value churn
    // exercises the immediate-dispose retire path. parked stays 0 every cycle.
    const bvValidator = makeValidator(R, (it) => it, { maxPool: Infinity });
    for (let c = 0; c < CYCLES; c++) {
        const items = new Array(ROWS);
        for (let k = 0; k < ROWS; k++) items[k] = { id: k, v: c };

        const src = R.signal(items.slice(), { equals: () => false });
        const mapped = reg.mapper.mapArray(src, makeByValueMapFn(R, sidBox), { byValue: true });
        const stop = R.effect(() => { void mapped(); });

        src.set(items.slice().reverse());                 // move
        src.set(items.slice(1).concat(items[0]));         // move
        const churned = items.slice();
        churned[3] = { id: 3, v: c + 1 };                 // new ref: insert + immediate retire
        src.set(churned);
        src.set(items.slice());                           // items[3] is a new key again -> rebuild
        bvValidator.resetIdentity();
        bvValidator.validate(mapped, items, 'T7 byValue cycle ' + c);

        const st = mapped.stats();
        check(st.live === ROWS,
            () => 'T7 byValue cycle ' + c + ': stats live=' + st.live + ' (expected ' + ROWS + ')');
        check(st.parked === 0,
            () => 'T7 byValue cycle ' + c + ': parked=' + st.parked + ' (byValue invariant: 0)');
        const hwBefore = st.highWater;

        const witnessItem = items[ROWS - 1];
        tracker.track(witnessItem, () => {}, 'bv#' + c);
        if (armed) held.push(witnessItem);

        stop();
        mapped.dispose();
        R.dispose(src);
        check(st.live === 0 && st.parked === 0,
            () => 'T7 byValue cycle ' + c + ': post-dispose stats not zeroed -- live=' + st.live +
                ' parked=' + st.parked);
        check(st.highWater === hwBefore,
            () => 'T7 byValue cycle ' + c + ': post-dispose highWater=' + st.highWater +
                ' (expected historical ' + hwBefore + ')');
        bvValidator.assertBase('T7 byValue cycle ' + c);
    }

    // Settle passes OUTSIDE any measured window: GC + macrotask yield so the FR
    // and finalization drain before the authoritative read.
    for (let p = 0; p < 6; p++) {
        globalThis.gc?.();
        await new Promise((r) => setTimeout(r, 30));
    }
    // Only the settled state is authoritative; discard transient live-stream
    // notifications emitted while finalization was still in flight.
    leaks.length = 0;
    warns.length = 0;
    const live = tracker.size();
    const findings = tracker.audit();

    check(live === 0,
        () => 'T7: retention witness did not drain -- tracker.size()=' + live + '/0 after settle ' +
            '(a scope outlived dispose(), pinning its item)');
    check(findings.length === 0,
        () => 'T7: lite-leak audit found ' + findings.length + ' orphan(s): ' +
            findings.map((f) => f.kind + ':' + f.reason).join(', '));
    check(leaks.length === 0,
        () => 'T7: lite-leak reported ' + leaks.length + ' leak(s): ' + leaks.join(', '));

    return { leakSize: live, findings: findings.length, warnings: warns.length };
}
