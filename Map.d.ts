/**
 * @zakkster/lite-map -- zero-GC keyed list reconciliation for @zakkster/lite-signal.
 *
 * Both primitives pass the CHANGING dimension as an accessor; that is what lets a
 * retired scope be reused by setting its signals instead of being rebuilt.
 */

/** A reactive read. A lite-signal handle satisfies this (it is callable). */
export type Accessor<T> = () => T;

/**
 * Pool observability for a mapped list. `live` is the current slot count, `parked`
 * the free-list length, and `highWater` the all-time peak of (live + parked) -- the
 * number the "growth past the high-water mark allocates" non-claim is about.
 */
export interface MappedStats {
    readonly live: number;
    readonly parked: number;
    readonly highWater: number;
}

/** The mapped output accessor. Reading it tracks structural changes to the list. */
export interface Mapped<O> {
    /**
     * The current mapped outputs in source order. The returned array is a single
     * persistent reference mutated in place (zero per-change allocation): read it
     * fresh on each reactive run; do not retain or reference-compare it.
     */
    (): O[];
    /**
     * Stop the reconcile driver and dispose every live and parked scope (including
     * the item/index signals the scope does not own). The caller owns teardown --
     * there is no auto-cleanup, so an enclosing scope re-running never tears the
     * list down, and you must call this when the list is no longer needed.
     */
    dispose(): void;
    /**
     * Pool counters for this list: { live, parked, highWater }. Allocation-free per
     * read -- ONE frozen object per instance, reused on every call. It is a LIVE
     * VIEW: the three fields change between reads WITHOUT calling stats() again, so
     * snapshot them (e.g. destructure) if you need a point-in-time copy. `highWater`
     * is the all-time peak of (live + parked) and is historical -- it survives
     * dispose(), which pins { live: 0, parked: 0, highWater: <peak> } (no throw).
     */
    stats(): MappedStats;
}

export interface IndexArrayOptions {
    /**
     * Cap on parked scopes retained for tail re-growth. Default: unbounded. Pass
     * `>= 1` to bound the pool; `0` is falsy and is treated as UNSET (unbounded)
     * today -- documented, not changed.
     */
    maxPool?: number;
}

export interface MapArrayOptions<T> {
    /**
     * Identity selector. Default: reference identity (the item itself). Keys must
     * be unique within the list; duplicate keys are not reconciled efficiently.
     */
    key?: (item: T) => unknown;
    /**
     * Cap on retired scopes retained for reuse by later inserts. Default: unbounded.
     * Pass `>= 1` to bound the pool; `0` is falsy and is treated as UNSET
     * (unbounded) today -- documented, not changed.
     */
    maxPool?: number;
}

/**
 * POSITION-keyed mapping. `item` is an accessor (the value shown at this slot can
 * change); `index` is a plain number (the slot itself is stable). Value churn at a
 * stable length is pure signal-set -- zero-GC; grow/shrink reuse tail slots through
 * a free-pool.
 */
export function indexArray<T, O>(
    list: Accessor<readonly T[]>,
    mapFn: (item: Accessor<T>, index: number) => O,
    opts?: IndexArrayOptions,
): Mapped<O>;

/**
 * ITEM-keyed mapping (by-accessor). BOTH `item` and `index` are accessors: items
 * keep identity across reorder (their reactive index updates), and a retired scope
 * is reused for a new item by setting its signals. Reorder/move and warm-pool
 * insert/remove are zero-GC; growth past the previous high-water mark allocates.
 */
export function mapArray<T, O>(
    list: Accessor<readonly T[]>,
    mapFn: (item: Accessor<T>, index: Accessor<number>) => O,
    opts?: MapArrayOptions<T>,
): Mapped<O>;

/** The subset of a lite-signal registry that createMapper binds to (>=1.6.0-preview.0). */
export interface SignalRegistry {
    signal: (...args: any[]) => any;
    effect: (...args: any[]) => any;
    createScope: (...args: any[]) => any;
    createRoot: (...args: any[]) => any;
    untrack: (...args: any[]) => any;
    dispose: (...args: any[]) => any;
}

export interface Mapper {
    mapArray: typeof mapArray;
    indexArray: typeof indexArray;
}

/**
 * Bind the primitives to an explicit registry (e.g. one from createRegistry). The
 * default exports `mapArray` / `indexArray` are bound to the default registry.
 */
export function createMapper(reg: SignalRegistry): Mapper;
