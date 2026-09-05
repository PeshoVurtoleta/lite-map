/**
 * @zakkster/lite-map -- the mandated torture gate.
 *
 * The DONE-WHEN of every session on this package is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * It proves the zero-GC claims the SUITE-MANDATED way -- with a lite-leak
 * retention witness (T7) and a lite-gc-profiler heap witness (T6) OVER the engine
 * pool counters -- and it ships a controls tier (T9) plus a walk driver
 * (test/controls.mjs) that demonstrably fail. Before C0 the only gate was the
 * engine's own pool counters on a "grow" bench registry (M-02): a green light
 * over the exact property it exists to protect.
 *
 * Tiers wired in C0 (sparse -- the fixed T0..T9 namespace, wire what the package
 * needs, reserve the rest for later sessions):
 *
 *     T0  metamorphic laws        T1  degenerate inputs
 *     T5  differential fuzz       T6  the allocation gate (THE tier)
 *     T7  soak + lite-leak        T9  controls (must be able to fail)
 *
 * Reserved / planned (named in test/torture/harness.mjs, non-failing):
 *     T2  (unused)  T3  (unused)  T4  (unused)  T8  (unused)
 *     C1 upgraded T6/T7's Pool line to mapped.stats() (M-04, landed);
 *     C2 adds a byValue T5/T6 variant (M-03);
 *     C3 benches output-move cost against T6's index-signal floor (M-01).
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent -- and T7 (which drains a
 * lite-leak FinalizationRegistry over settle passes) runs strictly AFTER T6.
 *
 * Controls: `LITEMAP_TORTURE_BREAK=t6 node --expose-gc test/torture.mjs` arms one
 * tier's deliberately-broken variant; the run MUST exit non-zero. The walk driver
 * arms each armable tier alone.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only. Map.js has zero
 * runtime dependencies.
 *
 * @license MIT
 */

import { SEED, BREAK, BACKSTOP_MESSAGE } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t5 } from './torture/t5-fuzz.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T5 fuzz', t5],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T9 controls', t9],
];

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    const metrics = { gc: { major: 0, minor: 0, maxMs: 0 }, leakSize: 0, findings: 0, warnings: 0 };

    for (const [name, run] of TIERS) {
        try {
            const out = await run();
            if (out && typeof out === 'object') {
                if (out.gc) metrics.gc = out.gc;
                if (typeof out.leakSize === 'number') metrics.leakSize = out.leakSize;
                if (typeof out.findings === 'number') metrics.findings = out.findings;
                if (typeof out.warnings === 'number') metrics.warnings = out.warnings;
            }
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means no control tripped. For a CONTROL-OWNING
    // tier that is a fault (its control failed to fire). For a non-owning tier
    // (t1/t9, which own no injectable control by design) this backstop IS the
    // expected outcome -- arming a tier with no control must still fail safe.
    // Either way: exit non-zero, never a silent "ok".
    if (BREAK) {
        process.stderr.write('torture: FAIL -- ' + BACKSTOP_MESSAGE + '\n');
        process.exit(1);
    }

    // Diagnostic GATE summary on stderr; stdout stays exactly "ok".
    process.stderr.write(
        'torture: GATE leak=size ' + metrics.leakSize + '/0' +
        ' findings=' + metrics.findings + ' warnings=' + metrics.warnings +
        ' | gc major=' + metrics.gc.major + ' minor=' + metrics.gc.minor +
        ' maxMs=' + metrics.gc.maxMs.toFixed(2) + '\n');

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
