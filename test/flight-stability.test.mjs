/**
 * Closed-loop stability test: FlightModel + MultiLevelLBM coupled the way
 * main.js couples them — physics ticks at ~15 Hz (the aero worker's rate) while
 * flight integrates at 60 Hz, reusing the last force/torque snapshot in between.
 *
 * Two failure modes are guarded here, both reported from the device:
 *
 *  1. "Stray leaf" — a creature dropped in STILL air should settle into a glide,
 *     not wobble between climbing and sinking.
 *  2. "Freaking out under a wind boost" — with a steady wind the body should
 *     drift WITH the air and settle, not overshoot the wind speed, reverse the
 *     relative flow, flip the lift sign, and oscillate. The root cause was a
 *     numerically stiff coupling: when the relative airspeed momentarily blew
 *     up, the LBM force spiked to tens of g and explicit integration slammed the
 *     velocity to its cap in one step — a self-sustaining limit cycle. The fix
 *     is in FlightModel: clamp the aero force to a physical envelope (maxAeroG)
 *     and integrate the wind-relative drag semi-implicitly (unconditionally
 *     stable, so it can be strong enough to actually hold the drift).
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

// Wings tilted to a 15° angle of attack (as main.js does in SIMULATE), so the
// creature makes real lift and the wind case can actually destabilize.
function tiltX(phi) { const c = Math.cos(phi), s = Math.sin(phi); return [[1,0,0],[0,c,s],[0,-s,c]]; }
const AOA = tiltX(-15 * Math.PI / 180), AX = [[1,0,0],[0,1,0],[0,0,1]];
const ALT = 40;
const parts = [
  { id: 'TORSO', position: [0, ALT,        0],     halfSize: [0.35, 0.35, 0.85], axes: AX,  velocity: [0,0,0] },
  { id: 'HEAD',  position: [0, ALT + 0.12, 0.78],  halfSize: [0.20, 0.20, 0.20], axes: AX,  velocity: [0,0,0] },
  { id: 'WINGL', position: [-1.0, ALT + 0.1, 0.05],halfSize: [1.0, 0.04, 0.40],  axes: AOA, velocity: [0,0,0] },
  { id: 'WINGR', position: [ 1.0, ALT + 0.1, 0.05],halfSize: [1.0, 0.04, 0.40],  axes: AOA, velocity: [0,0,0] },
  { id: 'SLAB',  position: [0, ALT + 0.04, -1.05], halfSize: [0.45, 0.03, 0.22], axes: AOA, velocity: [0,0,0] },
  { id: 'FIN',   position: [0, ALT + 0.26, -1.0],  halfSize: [0.04, 0.30, 0.22], axes: AX,  velocity: [0,0,0] },
];
const mb = measureCreature(parts);

// One closed-loop run. `opts` overrides FlightModel params so we can contrast a
// stabilized model against a deliberately-unstable one. Returns trajectory stats.
function runCoupled({ wind = [0,0,0], seconds = 12, ground = -1e4, flightOpts = {} }) {
  const flight = new FlightModel({ mass: 3, g: 9.8, dampRot: 8, maxRate: 18, maxOmega: 0.8, ...flightOpts });
  flight.setCreatureExtent(mb.W, mb.H, mb.L);
  flight.setLaunch(0, ground, 0);
  flight.y = ALT;
  flight.setWind(wind);
  flight.vy = -0.3; flight.vz = -1; flight.omega = [0.1, 0, 0.05];   // small kick

  const aero = new MultiLevelLBM(parts, {});
  aero.setWorldWind(wind);
  aero.setCreatureVelocity(flight.velocity());

  const RENDER_HZ = 60, PHYS_HZ = 15, ratio = RENDER_HZ / PHYS_HZ, dt = 1 / RENDER_HZ;
  const TORQUE_SCALE = 0.06;
  let force = [0,0,0], torque = [0,0,0];
  let liftFlips = 0, lastSign = 0, maxLift = -1e9, minLift = 1e9, maxSpeed = 0;
  const tailVz = [], tailVy = [];
  const N = RENDER_HZ * seconds;
  for (let i = 0; i < N; i++) {
    if (i % ratio === 0) {
      aero.setCreatureVelocity(flight.velocity());
      aero.step();
      force = aero.netForce();
      torque = aero.netTorque();
    }
    const [qx, qy, qz] = flight.q;
    const Kp = 3, Kd = 4;   // mild always-on leveling, as in main.js
    const tq = [
      torque[0] * TORQUE_SCALE - Kp * qx - Kd * flight.omega[0],
      torque[1] * TORQUE_SCALE - Kp * qy - Kd * flight.omega[1],
      torque[2] * TORQUE_SCALE - Kp * qz - Kd * flight.omega[2],
    ];
    flight.update(dt, force, tq);

    if (i > RENDER_HZ * 3) {
      const s = Math.sign(force[1]);
      if (s !== 0 && lastSign !== 0 && s !== lastSign) liftFlips++;
      if (s !== 0) lastSign = s;
      maxLift = Math.max(maxLift, force[1]); minLift = Math.min(minLift, force[1]);
    }
    maxSpeed = Math.max(maxSpeed, Math.hypot(flight.vx, flight.vy, flight.vz));
    if (i >= N - RENDER_HZ * 3) { tailVz.push(flight.vz); tailVy.push(flight.vy); }
    if (flight.y <= ground && i > 60) break;
  }
  const vzSettle = Math.max(...tailVz) - Math.min(...tailVz);
  const vySettle = Math.max(...tailVy) - Math.min(...tailVy);
  return { liftFlips, liftSwing: maxLift - minLift, maxSpeed, vzSettle, vySettle, finalVy: flight.vy, y: flight.y };
}

console.log('\n[stability] still-air drop settles into a glide ("stray leaf")');
{
  // A lifting creature glides down gently rather than plummeting, so we check it
  // SETTLES — a steady, slow sink with no wobble — not that it reaches the floor.
  const r = runCoupled({ wind: [0,0,0], seconds: 16 });
  check('steady gentle descent, not climbing or wobbling',
    r.finalVy < 0 && r.finalVy > -6 && r.vySettle < 3,
    `vy=${r.finalVy.toFixed(2)} vySettle=${r.vySettle.toFixed(2)}`);
  check('no lift sign thrashing', r.liftSwing < 200, `liftSwing=${r.liftSwing.toFixed(0)}N`);
  check('no runaway speed', r.maxSpeed < 10, `maxSpeed=${r.maxSpeed.toFixed(2)}`);
}

console.log('\n[stability] steady wind boost — drifts and settles, no oscillation');
{
  // The fix in place: bounded force + semi-implicit wind-relative damping.
  const good = runCoupled({ wind: [0,0,-12], flightOpts: { damp: 3, maxAeroG: 3 } });
  check('lift stays bounded (no ±hundreds-of-N reversal)', good.liftSwing < 200,
    `liftSwing=${good.liftSwing.toFixed(0)}N`);
  check('velocity settles near the wind drift (tight band)', good.vzSettle < 4,
    `vzSettle=${good.vzSettle.toFixed(2)} m/s`);
  check('does not pin at the rate cap', good.maxSpeed < 17.5, `maxSpeed=${good.maxSpeed.toFixed(2)}`);

  // Guard: remove the two safeguards (no force clamp, negligible damping) and the
  // same scenario must blow up — proving the harness detects the instability and
  // that the safeguards are what fix it.
  const bad = runCoupled({ wind: [0,0,-12], flightOpts: { damp: 0.01, maxAeroG: 1e9 } });
  check('guard: unclamped + undamped DOES oscillate violently', bad.liftSwing > 400,
    `liftSwing=${bad.liftSwing.toFixed(0)}N flips=${bad.liftFlips}`);
}

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
