/**
 * @zakkster/lite-map v1.1.1 -- zero-GC keyed list reconciliation for
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
 * reuse. (A by-value `mapArray` -- item as a plain value, Solid-style -- is a
 * planned opt-in; it cannot reuse a retired scope for a new item without
 * re-running mapFn, so its inserts pull from the pool.)
 *
 * -- OWNERSHIP --
 * Each item owns a createScope() scope (1.6.0+): its mapFn's effects/computeds
 * are adopted by the scope and torn down by one disposer. Per-item scopes and
 * the reconcile driver are detached from the calling scope, so an enclosing
 * effect re-running never cascade-disposes the list. The caller owns teardown:
 * the returned accessor carries a `.dispose()`.
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

        const makeSlot = (item, index) => {
            let slot;
            createScope((disposeScope) => {
                const itemSig = signal(item);
                const view = mapFn(() => itemSig(), index);
                slot = { itemSig, view, dispose: disposeScope, index, item };
            });
            return slot;
        };

        // Permanent teardown of a slot: cascade its scope (effects/computeds), then
        // dispose the itemSig the scope did NOT adopt (the engine never owner-adopts
        // signals). Parking a slot does NOT call this -- a parked slot stays live.
        const disposeSlot = (s) => { s.dispose(); dispose(s.itemSig); };

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

        const read = () => out();
        read.dispose = () => {
            stopDriver();
            for (let i = 0; i < scopes.length; i++) disposeSlot(scopes[i]);
            for (let i = 0; i < pool.length; i++) disposeSlot(pool[i]);
            dispose(out);
            scopes.length = 0; pool.length = 0; o.length = 0; len = 0;
        };
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
        const keyOf = (opts && opts.key) || ((item) => item);   // default: reference identity
        const maxPool = (opts && opts.maxPool) || Infinity;
        const byKey = new Map();   // key -> live slot (survivor lookup; mutated only on key change)
        const pool = [];            // retired slots (LIFO) reused for inserts
        let slots = [];             // current slots in source order
        let scratch = [];           // next-order scratch (persistent; swapped with `slots`)
        const o = [];               // output array (persistent, mutated in place)
        const out = signal(o, { equals: NEVER_EQUAL });
        let epoch = 0;

        const makeSlot = (item, index, key) => {
            let slot;
            createScope((disposeScope) => {
                const itemSig = signal(item);
                const idxSig = signal(index);
                const view = mapFn(() => itemSig(), () => idxSig());
                slot = { itemSig, idxSig, view, dispose: disposeScope, key, index, item, seen: epoch };
            });
            return slot;
        };

        // Permanent teardown: cascade the scope, then dispose the itemSig + idxSig
        // the scope did not adopt. Parking does NOT call this.
        const disposeSlot = (s) => { s.dispose(); dispose(s.itemSig); dispose(s.idxSig); };

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

        const read = () => out();
        read.dispose = () => {
            stopDriver();
            for (let i = 0; i < slots.length; i++) disposeSlot(slots[i]);
            for (let i = 0; i < pool.length; i++) disposeSlot(pool[i]);
            byKey.clear();
            dispose(out);
            slots = []; scratch = []; pool.length = 0; o.length = 0;
        };
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
