/**
 * Closed-loop stability test: FlightModel + MultiLevelLBM coupled the way
 * main.js couples them — physics ticks at ~15 Hz (the aero worker's rate)
 * while flight integrates at 60 Hz, reusing the last force/torque snapshot
 * in between. That mismatch makes the LBM's force a function of where the
 * creature WAS, not where it is "now" — a delayed-feedback loop that can
 * turn a damping force into a destabilizing one ("fall a bit → big lagged
 * shove the other way → overshoot → bigger shove back" — a "stray leaf").
 *
 * Run: node test/flight-stability.test.mjs
 */
import { FlightModel } from '../js/flight-model.js';
import { MultiLevelLBM } from '../js/lbm/multi-level.js';
import { measureCreature } from '../js/lbm/creature-bounds.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}  ${detail}`); }
}

// A bird-ish OBB layout, high enough off the ground that it can't land before
// the loop has had a chance to oscillate (or not).
const ALT = 40;
const parts = [
  { id: 'TORSO', position: [0, ALT,        0],     halfSize: [0.35, 0.35, 0.85], axes: [[1,0,0],[0,1,0],[0,0,1]], velocity: [0,0,0] },
  { id: 'HEAD',  position: [0, ALT + 0.12, 0.78],  halfSize: [0.20, 0.20, 0.20], axes: [[1,0,0],[0,1,0],[0,0,1]], velocity: [0,0,0] },
  { id: 'WINGL', position: [-0.9, ALT + 0.1, 0.05],halfSize: [0.85, 0.04, 0.30], axes: [[1,0,0],[0,1,0],[0,0,1]], velocity: [0,0,0] },
  { id: 'WINGR', position: [ 0.9, ALT + 0.1, 0.05],halfSize: [0.85, 0.04, 0.30], axes: [[1,0,0],[0,1,0],[0,0,1]], velocity: [0,0,0] },
  { id: 'SLAB',  position: [0, ALT + 0.04, -1.05], halfSize: [0.45, 0.03, 0.22], axes: [[1,0,0],[0,1,0],[0,0,1]], velocity: [0,0,0] },
  { id: 'FIN',   position: [0, ALT + 0.26, -1.0],  halfSize: [0.04, 0.30, 0.22], axes: [[1,0,0],[0,1,0],[0,0,1]], velocity: [0,0,0] },
];
const mb = measureCreature(parts);

function runDrop(damp) {
  const flight = new FlightModel({ mass: 4, g: 9.8, damp, dampRot: 6.0, maxRate: 18, maxOmega: 0.8 });
  flight.setCreatureExtent(mb.W, mb.H, mb.L);
  flight.setLaunch(0, 0, 0);
  flight.y = ALT;

  const aero = new MultiLevelLBM(parts, {});
  aero.setCreatureVelocity(flight.velocity());

  // "Falls just a bit" — the tiny nudge the user described as the trigger.
  flight.vy = -0.3;
  flight.omega = [0.05, 0, 0.05];

  const RENDER_HZ = 60, PHYS_HZ = 15, ratio = RENDER_HZ / PHYS_HZ, dt = 1 / RENDER_HZ;
  let force = [0, 0, 0], torque = [0, 0, 0];
  const TORQUE_SCALE = 0.12;

  let signFlips = 0, lastSign = 0, maxSpeed = 0;
  const N = RENDER_HZ * 45;
  for (let i = 0; i < N; i++) {
    if (i % ratio === 0) {
      aero.setCreatureVelocity(flight.velocity());
      aero.step();
      force = aero.netForce();
      torque = aero.netTorque();
    }
    const tq = [torque[0] * TORQUE_SCALE, torque[1] * TORQUE_SCALE, torque[2] * TORQUE_SCALE];
    flight.update(dt, force, tq);

    const sgn = Math.sign(flight.vy);
    if (sgn !== 0 && lastSign !== 0 && sgn !== lastSign) signFlips++;
    if (sgn !== 0) lastSign = sgn;
    maxSpeed = Math.max(maxSpeed, Math.hypot(flight.vx, flight.vy, flight.vz));

    if (flight.y <= 0 && i > 60) break;
  }
  return { signFlips, maxSpeed, finalVy: flight.vy, landed: flight.y <= 0 };
}

console.log('\n[stability] a falling creature settles instead of oscillating ("stray leaf")');
{
  // Reproduces the reported bug: with negligible instantaneous damping, the
  // LBM's lagged force overshoots every correction, and the fall never settles
  // — vy swings repeatedly between climbing and sinking (often pinned at the
  // rate cap in both directions).
  const bad = runDrop(0.01);
  check('regression guard: a near-zero damp DOES oscillate (sanity check)',
    bad.signFlips > 10, `flips=${bad.signFlips} maxSpeed=${bad.maxSpeed.toFixed(2)}`);

  // The fix: enough instantaneous (zero-lag) aerodynamic damping that the
  // body's own velocity — not the delayed LBM correction — sets the pace.
  const good = runDrop(1.0);
  check('with real damping, vy never reverses sign (no oscillation)',
    good.signFlips === 0, `flips=${good.signFlips}`);
  check('it settles into a steady glide, not a runaway', good.maxSpeed < 6,
    `maxSpeed=${good.maxSpeed.toFixed(2)}`);
  check('it reaches the ground falling, not bouncing around the sky',
    good.landed && good.finalVy <= 0, `landed=${good.landed} vy=${good.finalVy.toFixed(2)}`);
}

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
