/**
 * @zakkster/lite-map v1.4.0 -- zero-GC keyed list reconciliation for
 * @zakkster/lite-signal.
 * -----------------------------------------------------------------------------
 * Map a reactive array to per-item reactive scopes so that list mutation MOVES
 * and REBINDS scopes instead of rebuilding them, and only changed items
 * recompute. The differentiator vs Solid's mapArray: removed items' scopes go to
 * a free-list and are REUSED by later inserts -- so steady-state list churn over
 * a bounded set (the realistic shape: a few rows in/out, a reorder) pulls nothing
 * from the lite-signal pool and never grows it.
 *
 * DOM-free. The mapped output is whatever `mapFn` returns (a DOM node, a derived
 * value, a sub-view). signal-dom consumes the `() => O[]` accessor to build a
 * <For>; the core is testable under node:test with no DOM.
 *
 * -- TWO PRIMITIVES --
 *   indexArray(list, (item, index) => O)   POSITION-keyed. `item` is an accessor
 *       (the value at this slot changes), `index` is a plain number (the slot is
 *       stable). Value churn at a stable length is pure itemSig.set -- the clean
 *       zero-GC win; grow/shrink reuse tail slots through a free-pool.
 *   mapArray(list, (item, index) => O)     ITEM-keyed. BOTH `item` and `index`
 *       are accessors: items keep identity across reorder (their index moves),
 *       and a retired scope can be reused for a new item by setting its signals
 *       (no rebuild). `opts.key` selects the identity (default: reference).
 *
 * Both pass the CHANGING dimension as an accessor; that is what enables zero-GC
 * reuse. [1.3] `mapArray(list, mapFn, { byValue: true })` opts INTO plain-item
 * ergonomics (Solid-style): mapFn receives `item` as a plain value and `index`
 * as an accessor. A by-value view bakes the item into its closure -- no signal
 * to redirect -- so a MOVE still rides idxSig.set with no mapFn re-run, but an
 * INSERT re-runs mapFn and pulls a fixed node count from the pool (there is no
 * reuse mechanism, so removals dispose immediately and `parked` is always 0).
 * The door throws on `byValue + key`, `byValue + maxPool`, and a truthy-non-true
 * `byValue`; keys are by REFERENCE identity (SameValueZero). The by-accessor
 * mode (byValue absent/false) is the zero-GC default and is byte-for-byte
 * unchanged by the opt-in.
 *
 * -- OWNERSHIP --
 * Each item owns a createScope() scope (1.6.0+): its mapFn's effects/computeds
 * are adopted by the scope and torn down by one disposer. Per-item scopes and
 * the reconcile driver are detached from the calling scope, so an enclosing
 * effect re-running never cascade-disposes the list. The caller owns teardown:
 * the returned accessor carries a `.dispose()`.
 *
 * -- OBSERVABILITY --
 * The returned accessor also carries a `.stats()` -> { live, parked, highWater }:
 * a reused, Object.freeze'd LIVE VIEW (its getters read the current slot/pool
 * lengths and a per-instance high-water counter, so fields change between reads
 * WITHOUT another stats() call -- snapshot the three fields if you need a
 * point-in-time copy). Allocation-free per read: one frozen object per instance,
 * built at creation. highWater is the all-time peak of (live + parked) and is
 * historical -- it survives dispose(), which pins { 0, 0, <peak> }.
 *
 * -- ZERO-GC, AND THE HONEST NON-CLAIMS --
 * PASS (no pool pull, no growth, after warm-up):
 *   - indexArray value churn at a stable length (itemSig.set per changed slot).
 *   - mapArray reorder / move (idxSig.set on survivors that shifted).
 *   - mapArray insert/remove while the free-list is warm (a retired scope is
 *     reused by setting item/index signals).
 *   - mapArray tail append / pop / in-place value churn (1.1): a position-aligned
 *     common-prefix scan classifies these before the general keyed diff, so the
 *     byKey Map, scope pool and scratch swap never churn -- only O(delta) tail
 *     work runs. Any non-tail shape (prepend, reorder, middle insert/remove)
 *     falls through to the general path unchanged.
 *   - indexArray tail grow/shrink serviced by the free-pool (push/pop at the end).
 * NOT claimed:
 *   - List GROWTH past the previous high-water mark pulls scopes from the pool
 *     (there is no representing N+1 distinct items with N scopes).
 *   - The keyed `byKey` Map mutates (set/delete) on actual key changes -- a JS
 *     allocation the engine's pool counters do not see. Reorder touches no key,
 *     so it does not churn the Map.
 *   - The user's mapFn body. If it allocates per re-run, that is the caller's.
 *
 * Registry-parametric: createMapper(reg) binds to any registry exposing
 * createScope (>=1.6.0). Default-bound `mapArray` / `indexArray` are exported.
 *
 * MIT (c) 2026 Zahary Shinikchiev
 */

import {
    signal as _signal,
    effect as _effect,
    createScope as _createScope,
    createRoot as _createRoot,
    untrack as _untrack,
    dispose as _dispose,
} from "@zakkster/lite-signal";

// Output signals always re-fire on set: the mapped array is one persistent,
// mutated-in-place reference (zero per-change allocation), so a value-equal
// Object.is check would suppress the update. Reconcile only sets `out` when the
// structure actually changed, so this never produces a spurious downstream run.
const NEVER_EQUAL = () => false;

/**
 * Bind the list-reconciliation primitives to a registry.
 * @param {{signal:Function, effect:Function, createScope:Function, createRoot:Function, untrack:Function, dispose:Function}} reg
 * @returns {{mapArray:Function, indexArray:Function}}
 */
export function createMapper(reg) {
    const signal = reg.signal;
    const effect = reg.effect;
    const createScope = reg.createScope;
    const createRoot = reg.createRoot;
    const untrack = reg.untrack;
    const dispose = reg.dispose;

    // ---- indexArray: position-keyed ------------------------------------------
    /**
     * @param {() => Array<unknown>} list Reactive source array (accessor/signal).
     * @param {(item:() => unknown, index:number) => unknown} mapFn
     * @param {{maxPool?:number}} [opts]
     * @returns {(() => Array<unknown>) & { dispose: () => void }}
     */
    function indexArray(list, mapFn, opts) {
        const maxPool = (opts && opts.maxPool) || Infinity;
        const scopes = [];     // scopes[i] is the live slot for index i
        const pool = [];        // parked slots (LIFO); reused on tail re-grow
        const o = [];           // the output array (persistent, mutated in place)
        const out = signal(o, { equals: NEVER_EQUAL });
        let len = 0;
        let total = 0, highWater = 0;   // live + parked population, and its all-time peak

        const makeSlot = (item, index) => {
            let slot;
            createScope((disposeScope) => {
                const itemSig = signal(item);
                const view = mapFn(() => itemSig(), index);
                slot = { itemSig, view, dispose: disposeScope, index, item };
            });
            // AFTER createScope returns: a throwing mapFn never enters scopes/pool
            // and so can never be decremented -- do not count it (fail closed).
            total++; if (total > highWater) highWater = total;
            return slot;
        };

        // Permanent teardown of a slot: cascade its scope (effects/computeds), then
        // dispose the itemSig the scope did NOT adopt (the engine never owner-adopts
        // signals). Parking a slot does NOT call this -- a parked slot stays live.
        const disposeSlot = (s) => { s.dispose(); dispose(s.itemSig); total--; };

        // Reuse a parked slot only when its baked index matches the target (so the
        // plain-number `index` mapFn received stays correct). Descending park +
        // ascending grow keeps the LIFO top aligned for balanced tail churn.
        const acquire = (item, index) => {
            const top = pool.length !== 0 ? pool[pool.length - 1] : undefined;
            if (top !== undefined && top.index === index) {
                pool.pop();
                if (!Object.is(top.item, item)) { top.itemSig.set(item); top.item = item; }
                return top;
            }
            return makeSlot(item, index);
        };

        const reconcile = (arr) => {
            const n = arr.length;
            const lim = n < len ? n : len;
            let changed = false;
            for (let i = 0; i < lim; i++) {
                const s = scopes[i];
                if (!Object.is(s.item, arr[i])) { s.itemSig.set(arr[i]); s.item = arr[i]; }
            }
            if (n < len) {
                for (let i = len - 1; i >= n; i--) {        // park tail, descending
                    const s = scopes[i];
                    if (pool.length < maxPool) pool.push(s); else disposeSlot(s);
                }
                scopes.length = n;
                changed = true;
            } else if (n > len) {
                for (let i = len; i < n; i++) scopes[i] = acquire(arr[i], i);   // grow ascending
                changed = true;
            }
            len = n;
            if (changed) {
                o.length = n;
                for (let i = 0; i < n; i++) o[i] = scopes[i].view;
                out.set(o);
            }
        };

        let stopDriver;
        createRoot(() => { stopDriver = effect(() => { const arr = list(); untrack(() => reconcile(arr)); }); });

        // One frozen LIVE VIEW per instance: getters read the current lengths and
        // the closure highWater at call time (never a captured snapshot), so the
        // object is reference-stable and allocation-free per read.
        const statsView = Object.freeze({
            get live() { return scopes.length; },
            get parked() { return pool.length; },
            get highWater() { return highWater; },
        });

        const read = () => out();
        read.dispose = () => {
            stopDriver();
            for (let i = 0; i < scopes.length; i++) disposeSlot(scopes[i]);
            for (let i = 0; i < pool.length; i++) disposeSlot(pool[i]);
            dispose(out);
            scopes.length = 0; pool.length = 0; o.length = 0; len = 0;
        };
        read.stats = () => statsView;
        return read;
    }

    // ---- mapArray: item-keyed (by-accessor) ----------------------------------
    /**
     * @param {() => Array<unknown>} list Reactive source array (accessor/signal).
     * @param {(item:() => unknown, index:() => number) => unknown} mapFn
     * @param {{key?:(item:unknown)=>unknown, maxPool?:number}} [opts]
     * @returns {(() => Array<unknown>) & { dispose: () => void }}
     */
    function mapArray(list, mapFn, opts) {
        if (opts && opts.byValue) return mapArrayByValue(list, mapFn, opts);   // [1.3] cold dispatch; door lives in the byValue family
        const keyOf = (opts && opts.key) || ((item) => item);   // default: reference identity
        const maxPool = (opts && opts.maxPool) || Infinity;
        const byKey = new Map();   // key -> live slot (survivor lookup; mutated only on key change)
        const pool = [];            // retired slots (LIFO) reused for inserts
        let slots = [];             // current slots in source order
        let scratch = [];           // next-order scratch (persistent; swapped with `slots`)
        const o = [];               // output array (persistent, mutated in place)
        const out = signal(o, { equals: NEVER_EQUAL });
        let epoch = 0;
        let total = 0, highWater = 0;   // live + parked population, and its all-time peak

        const makeSlot = (item, index, key) => {
            let slot;
            createScope((disposeScope) => {
                const itemSig = signal(item);
                const idxSig = signal(index);
                const view = mapFn(() => itemSig(), () => idxSig());
                slot = { itemSig, idxSig, view, dispose: disposeScope, key, index, item, seen: epoch };
            });
            // AFTER createScope returns: a throwing mapFn never enters slots/pool
            // and so can never be decremented -- do not count it (fail closed).
            total++; if (total > highWater) highWater = total;
            return slot;
        };

        // Permanent teardown: cascade the scope, then dispose the itemSig + idxSig
        // the scope did not adopt. Parking does NOT call this.
        const disposeSlot = (s) => { s.dispose(); dispose(s.itemSig); dispose(s.idxSig); total--; };

        // A genuinely-new key: reuse a retired scope (rebind its signals -- zero-GC)
        // or build one.
        //
        // `register` is false for a DUPLICATE key (README: keys must be unique).
        // Registering a duplicate used to overwrite the byKey entry of the slot
        // that legitimately owns that key, and the damage OUTLIVED the duplicate:
        // once the dupe was removed, retire() deleted the entry (it matched the
        // dupe), leaving the original slot live but unreachable through byKey. The
        // next reorder then treated a survivor as new and handed it a fresh scope
        // -- silent identity loss on a key that was unique again by then. An
        // unregistered duplicate is self-contained: it cannot evict anyone, and
        // retire()'s `byKey.get(s.key) === s` guard already declines to delete an
        // entry it does not own.
        const acquire = (item, index, key, register) => {
            let s;
            if (pool.length !== 0) {
                s = pool.pop();
                // A pooled slot must not leave a stale byKey entry behind under its
                // PREVIOUS key. retire() normally clears it, but it declines when
                // the entry was overwritten, so re-keying without this check could
                // strand an entry pointing at a slot that no longer holds that key.
                if (byKey.get(s.key) === s) byKey.delete(s.key);
                s.key = key; s.index = index; s.item = item; s.seen = epoch;
                s.itemSig.set(item);
                s.idxSig.set(index);
            } else {
                s = makeSlot(item, index, key);
            }
            if (register) byKey.set(key, s);
            return s;
        };

        const retire = (s) => {
            if (byKey.get(s.key) === s) byKey.delete(s.key);
            if (pool.length < maxPool) pool.push(s); else disposeSlot(s);
        };

        const reconcile = (arr) => {
            epoch = (epoch + 1) | 0;
            const n = arr.length;
            const prevN = slots.length;

            // ---- tail fast-paths (1.1) --------------------------------------
            // Scan the longest position-aligned common PREFIX by key. The
            // dominant real-world mutations -- append, pop, and in-place value
            // churn (feeds, logs, push/pop) -- leave the whole prefix intact, so
            // the general keyed diff below (with its per-item byKey.get, scratch
            // swap and full retire scan) is skipped: the only structural work is
            // O(delta) at the tail, and the byKey Map / scope pool never churn.
            // Detection is a pure key scan with NO side effects, so any non-tail
            // shape (prepend, reorder, middle insert/remove) falls cleanly
            // through to the correct general path. The prefix invariant
            // slots[i].index === i is preserved by every branch, so a survivor
            // that stays at its index needs no idxSig write.
            const lim = n < prevN ? n : prevN;
            let p = 0;
            while (p < lim && keyOf(arr[p]) === slots[p].key) p++;

            if (p === prevN && p === n) {
                // Same keys, same order: value-only churn (or a no-op). Refresh
                // changed values in place; no structural change => `out` is
                // silent (matches the value-churn contract).
                for (let i = 0; i < n; i++) {
                    const s = slots[i]; s.seen = epoch;
                    const item = arr[i];
                    if (!Object.is(s.item, item)) { s.itemSig.set(item); s.item = item; }
                }
                return;
            }
            if (p === prevN && n > prevN) {
                // Pure append: the prefix is every existing slot; [prevN, n) is
                // new tail. No reorder, no retire, no scratch swap.
                for (let i = 0; i < prevN; i++) {
                    const s = slots[i]; s.seen = epoch;
                    const item = arr[i];
                    if (!Object.is(s.item, item)) { s.itemSig.set(item); s.item = item; }
                }
                for (let i = prevN; i < n; i++) {
                    const k = keyOf(arr[i]);
                    slots[i] = acquire(arr[i], i, k, !byKey.has(k));
                }
                o.length = n;
                for (let i = prevN; i < n; i++) o[i] = slots[i].view;
                out.set(o);
                return;
            }
            if (p === n && prevN > n) {
                // Pure pop: the prefix is every surviving slot; the old tail
                // [n, prevN) is retired to the free-list. No reorder, no swap.
                for (let i = 0; i < n; i++) {
                    const s = slots[i]; s.seen = epoch;
                    const item = arr[i];
                    if (!Object.is(s.item, item)) { s.itemSig.set(item); s.item = item; }
                }
                for (let i = n; i < prevN; i++) retire(slots[i]);
                slots.length = n;
                o.length = n;
                out.set(o);
                return;
            }

            // ---- general keyed diff (prepend / reorder / middle insert-remove)
            let changed = false;
            for (let i = 0; i < n; i++) {
                const item = arr[i];
                const key = keyOf(item);
                const existing = byKey.get(key);
                if (existing !== undefined && existing.seen !== epoch) {   // survivor (first hit this epoch)
                    existing.seen = epoch;
                    if (existing.index !== i) { existing.index = i; existing.idxSig.set(i); changed = true; }
                    if (!Object.is(existing.item, item)) { existing.itemSig.set(item); existing.item = item; }
                    scratch[i] = existing;
                } else {                                                    // new key (or duplicate)
                    scratch[i] = acquire(item, i, key, existing === undefined);
                    changed = true;
                }
            }
            // Retire any slot from the previous arrangement not reused this epoch.
            for (let i = 0; i < slots.length; i++) {
                const s = slots[i];
                if (s.seen !== epoch) { retire(s); changed = true; }
            }
            scratch.length = n;
            const tmp = slots; slots = scratch; scratch = tmp;   // swap, no allocation
            if (changed) {
                o.length = n;
                for (let i = 0; i < n; i++) o[i] = slots[i].view;
                out.set(o);
            }
        };

        let stopDriver;
        createRoot(() => { stopDriver = effect(() => { const arr = list(); untrack(() => reconcile(arr)); }); });

        // One frozen LIVE VIEW per instance. `slots` is a let, swapped with
        // `scratch` on every general diff and reassigned to [] on dispose, so the
        // getter must name the VARIABLE directly (never a captured array ref) --
        // a captured ref would report the stale scratch length forever.
        const statsView = Object.freeze({
            get live() { return slots.length; },
            get parked() { return pool.length; },
            get highWater() { return highWater; },
        });

        const read = () => out();
        read.dispose = () => {
            stopDriver();
            for (let i = 0; i < slots.length; i++) disposeSlot(slots[i]);
            for (let i = 0; i < pool.length; i++) disposeSlot(pool[i]);
            byKey.clear();
            dispose(out);
            slots = []; scratch = []; pool.length = 0; o.length = 0;
        };
        read.stats = () => statsView;
        return read;
    }

    // ---- mapArray: item-keyed (by-VALUE opt-in, [1.3]) -----------------------
    //
    // A sibling family selected ONCE at creation (the statsView pattern extended
    // to a whole function set), so the accessor family above is byte-for-byte
    // untouched. mapFn receives the PLAIN item and an index accessor; a view bakes
    // the item into its closure, so there is NO itemSig and NO value-refresh line
    // anywhere -- the four accessor refresh lines and the acquire rebind are
    // ABSENT, not conditioned. Keys are the item by REFERENCE (SameValueZero).
    //
    // Cost contract (pinned by the T6 phase-4 gate): a MOVE rides idxSig.set with
    // no mapFn re-run (pool-flat); an INSERT re-runs mapFn once and allocates a
    // fixed node count k. The free-list cannot serve a byValue insert (a parked
    // view is baked to its old item), so removals dispose IMMEDIATELY and
    // `parked === 0` is an invariant (fact b).
    /**
     * @param {() => Array<unknown>} list
     * @param {(item:unknown, index:() => number) => unknown} mapFn
     * @param {{byValue:true}} opts
     * @returns {(() => Array<unknown>) & { dispose: () => void }}
     */
    function mapArrayByValue(list, mapFn, opts) {
        // ---- door (cold, fail closed, ASCII did-you-mean) --------------------
        if (opts.byValue !== true) {
            throw new TypeError("mapArray: opts.byValue must be exactly `true` to select " +
                "by-value mode (a truthy non-true value is not a silent opt-in) -- did you mean { byValue: true }?");
        }
        if (opts.key !== undefined) {
            throw new TypeError("mapArray: { byValue: true } cannot be combined with `key` -- a by-value " +
                "view bakes the plain item and cannot absorb an item change under a stable custom key; " +
                "byValue keys by reference identity. Drop `key`, or drop `byValue` for the accessor mode.");
        }
        if (opts.maxPool !== undefined) {
            throw new TypeError("mapArray: { byValue: true } cannot be combined with `maxPool` -- a by-value " +
                "insert cannot reuse a parked scope, so the free-list is never used (parked is always 0) and a " +
                "cap on it is a silent no-op. Drop `maxPool`, or drop `byValue` for the accessor mode.");
        }

        const keyOf = (item) => item;   // by-value: the item IS the key (reference identity)
        const byKey = new Map();         // key -> live slot (survivor lookup)
        const pool = [];                 // ALWAYS empty (parked === 0 invariant); kept for statsView symmetry
        let slots = [];
        let scratch = [];
        const o = [];
        const out = signal(o, { equals: NEVER_EQUAL });
        let epoch = 0;
        let total = 0, highWater = 0;

        // No itemSig: a plain item cannot be redirected. The view captures `item`
        // in mapFn's closure; only idxSig exists (moves ride it).
        const makeSlot = (item, index, key) => {
            let slot;
            createScope((disposeScope) => {
                const idxSig = signal(index);
                const view = mapFn(item, () => idxSig());
                slot = { idxSig, view, dispose: disposeScope, key, index, item, seen: epoch };
            });
            total++; if (total > highWater) highWater = total;
            return slot;
        };

        // Permanent teardown: cascade the scope, dispose the idxSig it did not
        // adopt. There is no itemSig to dispose.
        const disposeSlot = (s) => { s.dispose(); dispose(s.idxSig); total--; };

        // A genuinely-new key ALWAYS builds (the free-list cannot serve byValue).
        // `register` is false for a contained duplicate (same containment law as
        // the accessor family).
        const acquire = (item, index, key, register) => {
            const s = makeSlot(item, index, key);
            if (register) byKey.set(key, s);
            return s;
        };

        // byValue retire = immediate disposeSlot (fact b: no parking).
        const retire = (s) => {
            if (byKey.get(s.key) === s) byKey.delete(s.key);
            disposeSlot(s);
        };

        const reconcile = (arr) => {
            epoch = (epoch + 1) | 0;
            const n = arr.length;
            const prevN = slots.length;

            // Prefix classifier (kept). By-value keys ARE the items, so `===` here
            // is the SameValueZero prefix scan: -0 and 0 match, so -0 <-> 0 is NOT
            // an item change. The value-churn branch degrades to a seen-stamp loop
            // (no refresh line -- nothing can change under a matched key).
            const lim = n < prevN ? n : prevN;
            let p = 0;
            while (p < lim && keyOf(arr[p]) === slots[p].key) p++;

            if (p === prevN && p === n) {
                // Same keys, same order: pure no-op (a matched key IS the same
                // item). Stamp seen for the general path's invariant; `out` silent.
                for (let i = 0; i < n; i++) slots[i].seen = epoch;
                return;
            }
            if (p === prevN && n > prevN) {
                // Pure append: [prevN, n) is new tail. Each new row builds.
                for (let i = 0; i < prevN; i++) slots[i].seen = epoch;
                for (let i = prevN; i < n; i++) {
                    const k = keyOf(arr[i]);
                    slots[i] = acquire(arr[i], i, k, !byKey.has(k));
                }
                o.length = n;
                for (let i = prevN; i < n; i++) o[i] = slots[i].view;
                out.set(o);
                return;
            }
            if (p === n && prevN > n) {
                // Pure pop: old tail [n, prevN) disposes immediately (no parking).
                for (let i = 0; i < n; i++) slots[i].seen = epoch;
                for (let i = n; i < prevN; i++) retire(slots[i]);
                slots.length = n;
                o.length = n;
                out.set(o);
                return;
            }

            // ---- general keyed diff (prepend / reorder / middle insert-remove)
            let changed = false;
            for (let i = 0; i < n; i++) {
                const item = arr[i];
                const key = keyOf(item);
                const existing = byKey.get(key);
                if (existing !== undefined && existing.seen !== epoch) {   // survivor (moves ride idxSig)
                    existing.seen = epoch;
                    if (existing.index !== i) { existing.index = i; existing.idxSig.set(i); changed = true; }
                    scratch[i] = existing;
                } else {                                                    // new key (or duplicate): build
                    scratch[i] = acquire(item, i, key, existing === undefined);
                    changed = true;
                }
            }
            for (let i = 0; i < slots.length; i++) {
                const s = slots[i];
                if (s.seen !== epoch) { retire(s); changed = true; }        // disposes immediately
            }
            scratch.length = n;
            const tmp = slots; slots = scratch; scratch = tmp;
            if (changed) {
                o.length = n;
                for (let i = 0; i < n; i++) o[i] = slots[i].view;
                out.set(o);
            }
        };

        let stopDriver;
        createRoot(() => { stopDriver = effect(() => { const arr = list(); untrack(() => reconcile(arr)); }); });

        // parked reads pool.length, which stays 0 for the life of a byValue list.
        const statsView = Object.freeze({
            get live() { return slots.length; },
            get parked() { return pool.length; },
            get highWater() { return highWater; },
        });

        const read = () => out();
        read.dispose = () => {
            stopDriver();
            for (let i = 0; i < slots.length; i++) disposeSlot(slots[i]);
            byKey.clear();
            dispose(out);
            slots = []; scratch = []; o.length = 0;
        };
        read.stats = () => statsView;
        return read;
    }

    return { mapArray, indexArray };
}

// Default-registry convenience.
const _default = createMapper({
    signal: _signal,
    effect: _effect,
    createScope: _createScope,
    createRoot: _createRoot,
    untrack: _untrack,
    dispose: _dispose,
});

export const mapArray = _default.mapArray;
export const indexArray = _default.indexArray;
