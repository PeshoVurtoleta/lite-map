/**
 * @zakkster/lite-map -- control driver.
 *
 * Every gate must be provably able to fail. Running the suite with every control
 * armed at once proves only that SOMETHING failed: t0 runs first, trips, and
 * exits, so the later controls never execute. A control that never executes is
 * not a proven control -- it is a comment.
 *
 * This driver walks EVERY armable tier ALONE and requires the right kind of
 * non-zero exit for that tier, then requires the clean run to exit zero. Both
 * directions matter: a suite that always fails is as useless as one that never
 * does. Two classes of tier (single source of truth in torture/harness.mjs):
 *
 *   CONTROL-OWNING (t0, t5, t6, t7) -- own an injectable control keyed to
 *     breaking(tier). Armed alone they MUST print their own `TN:` tag, exit
 *     non-zero, and MUST NOT emit CONTROL-DEFEATED. The defeat token is what makes
 *     a WIDENED-until-useless gate distinguishable from a working one: a control
 *     that dies in BOTH its "tripped" and its "armed-but-defeated" branch looks
 *     identical to a driver that only checks the exit code and the tag. The
 *     defeated branch emits CONTROL-DEFEATED; this driver asserts it is ABSENT.
 *
 *   ASSERTION (t1, t9) -- own NO injectable control by design (t1 is a
 *     degenerate-input assertion tier; t9's controls run every invocation).
 *     Arming one exercises the entry-point BACKSTOP: no tier trips, so the run
 *     fails safe with the shared backstop message. Proving the backstop bites is a
 *     real property -- arming a tier that has no control must never print "ok".
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';
import {
    CONTROL_OWNING_TIERS,
    ALL_ARMABLE_TIERS,
    CONTROL_DEFEATED_TOKEN,
    BACKSTOP_MESSAGE,
} from './torture/harness.mjs';

const ENTRY = new URL('./torture.mjs', import.meta.url).pathname;

/** Run the torture entry with a given control armed. Returns exit code + output. */
function runWith(breakValue) {
    const env = Object.assign({}, process.env);
    if (breakValue === null) delete env.LITEMAP_TORTURE_BREAK;
    else env.LITEMAP_TORTURE_BREAK = breakValue;

    const res = spawnSync(process.execPath, ['--expose-gc', ENTRY], { env, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
    process.stderr.write('controls: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// 1. The clean run must pass. If it does not, every control below is meaningless
//    -- they would "fail" for the wrong reason.
{
    const r = runWith(null);
    if (r.code !== 0) {
        fail('clean run exited ' + r.code + ' (expected 0)\n' + r.stderr);
    }
    if (r.stdout.trim() !== 'ok') {
        fail('clean run stdout was ' + JSON.stringify(r.stdout) + ', expected exactly "ok"');
    }
}

// 2. Walk EVERY armable tier alone. Each must exit non-zero and never print "ok";
//    the KIND of failure required depends on whether the tier owns a control.
for (const tier of ALL_ARMABLE_TIERS) {
    const r = runWith(tier);
    const owns = CONTROL_OWNING_TIERS.indexOf(tier) !== -1;

    if (r.code === 0) {
        fail(tier + ' armed but the suite still exited 0 -- that gate is decorative');
    }
    if (r.stdout.trim() === 'ok') {
        fail(tier + ' armed but printed "ok" on a failing run');
    }
    // A defeated control must never masquerade as a working one, in ANY tier.
    if (r.stderr.indexOf(CONTROL_DEFEATED_TOKEN) !== -1) {
        fail(tier + ' emitted ' + CONTROL_DEFEATED_TOKEN + ' -- its gate was armed but ' +
            'could not catch the injected fault (a widened/broken gate):\n' + r.stderr);
    }

    if (owns) {
        // Must trip for its OWN reason: the tier tag must appear. A t6 control that
        // trips because t0 broke is not a t6 control.
        const tag = tier.toUpperCase() + ':';
        if (r.stderr.indexOf(tag) === -1) {
            fail(tier + ' (control-owning) exited ' + r.code + ' but no ' + tag +
                ' failure was reported -- it tripped somewhere else:\n' + r.stderr);
        }
    } else {
        // Owns no control by design: arming it must fall through to the backstop.
        if (r.stderr.indexOf(BACKSTOP_MESSAGE) === -1) {
            fail(tier + ' (owns no control) exited ' + r.code + ' without the backstop message ' +
                JSON.stringify(BACKSTOP_MESSAGE) + ' -- arming it tripped something else:\n' + r.stderr);
        }
    }
}

process.stdout.write('ok\n');
