/**
 * Headless tests for the free-flight vertical model.
 * Run: node test/flight-model.test.mjs
 */
import { FlightModel } from '../js/flight-model.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}  ${detail}`); }
}

console.log('\n[flight] lift vs weight drives climb / sink / level');
{
  const m = new FlightModel({ mass: 4, g: 9.8, damp: 0.8 });
  const W = m.weight();

  // Excess lift → climbs.
  m.reset();
  for (let i = 0; i < 120; i++) m.update(1 / 60, W * 1.5);
  check('excess lift climbs', m.y > 0.1, `y=${m.y.toFixed(2)} vy=${m.vy.toFixed(2)}`);
  check('climb state reported', m.state() === 'climbing' || m.y > 0, m.state());

  // Lift below weight from altitude → sinks back toward the floor.
  m.y = 5; m.vy = 0;
  for (let i = 0; i < 240; i++) m.update(1 / 60, W * 0.4);
  check('deficient lift sinks', m.y < 5, `y=${m.y.toFixed(2)}`);

  // Lift exactly balances weight → near-stationary.
  m.reset(); m.y = 3; m.vy = 0;
  for (let i = 0; i < 240; i++) m.update(1 / 60, W);
  check('balanced lift ≈ level flight', Math.abs(m.vy) < 0.05, `vy=${m.vy.toFixed(3)}`);
}

console.log('\n[flight] safety: ground clamp, rate cap, finiteness');
{
  const m = new FlightModel({ mass: 2, maxRate: 12 });
  m.reset();
  for (let i = 0; i < 600; i++) m.update(1 / 60, 0); // no lift, falling
  check('cannot fall below launch floor', m.y >= 0, `y=${m.y}`);

  m.reset();
  for (let i = 0; i < 600; i++) m.update(1 / 60, m.weight() * 100); // absurd lift
  check('vertical rate is capped', Math.abs(m.vy) <= 12 + 1e-6, `vy=${m.vy}`);
  check('altitude stays finite', Number.isFinite(m.y));

  // A long stall frame must not blow up.
  m.reset();
  m.update(5.0, m.weight() * 50);
  check('long frame is sub-stepped/clamped (finite)', Number.isFinite(m.y) && Number.isFinite(m.vy), `y=${m.y} vy=${m.vy}`);

  // Disabled model holds position.
  m.reset(); m.enabled = false;
  for (let i = 0; i < 60; i++) m.update(1 / 60, m.weight() * 5);
  check('disabled model does not move', m.y === 0 && m.vy === 0);
}

console.log('\n[flight] full 3-axis force vector + velocity feedback');
{
  const m = new FlightModel({ mass: 4, g: 9.8 });
  const W = m.weight();

  // A lateral aero force (fx) accelerates the creature sideways in x.
  m.reset();
  for (let i = 0; i < 120; i++) m.update(1 / 60, [W * 0.5, W, 0]);
  check('lateral force moves x', m.x > 0.05, `x=${m.x.toFixed(3)}`);
  check('lateral force builds vx', m.vx > 0.05, `vx=${m.vx.toFixed(3)}`);

  // Throttle drives forward (z) motion and is exposed on velocity().
  m.reset();
  m.update(1 / 60, [0, W, 0], null, 10);
  check('throttle sets forward speed', Math.abs(m.velocity()[2] - 10) < 1e-9, `vz=${m.vz}`);
  check('velocity() returns the 3-vector fed back to the solver', m.velocity().length === 3);

  // Stall + no lift → it accelerates downward; that −vy is what becomes the
  // upward relative wind the solver feels ("the wind of its falling").
  m.setLaunch(0, 0, 0); m.y = 20;   // launch floor at 0, but drop from altitude
  for (let i = 0; i < 30; i++) m.update(1 / 60, [0, 0, 0]);
  check('zero lift from altitude builds downward velocity', m.vy < -0.5, `vy=${m.vy.toFixed(2)}`);
  check('falling velocity is the feedback signal', m.velocity()[1] === m.vy);

  // Feeding back real vertical drag (a force opposing the fall) arrests it —
  // emergent terminal velocity, not a scripted clamp.
  const v0 = m.vy;
  for (let i = 0; i < 60; i++) m.update(1 / 60, [0, W * 1.2, 0]); // drag now exceeds weight
  check('upward aero force (drag) decelerates the fall', m.vy > v0, `v0=${v0.toFixed(2)} → vy=${m.vy.toFixed(2)}`);
}

console.log('\n[flight] rotation: torque → angular velocity → quaternion');
{
  const m = new FlightModel({ mass: 4, g: 9.8 });
  m.setCreatureExtent(3, 0.5, 0.5);  // bird-like: wide, thin
  const W = m.weight();

  // Roll torque (about z axis in flight frame) should build angular velocity.
  m.reset();
  for (let i = 0; i < 60; i++) m.update(1 / 60, [0, W, 0], [0, 0, 2.0], 8);
  check('roll torque builds omega_z', Math.abs(m.omega[2]) > 0.05, `ω_z=${m.omega[2].toFixed(3)}`);

  // Quaternion should depart from identity after torque integration.
  const angleFromIdentity = 2 * Math.acos(Math.min(1, Math.abs(m.q[3])));
  check('orientation departs from identity', angleFromIdentity > 0.01, `angle=${angleFromIdentity.toFixed(4)} rad`);

  // Quaternion must stay unit-length.
  const qLen = Math.sqrt(m.q.reduce((s, v) => s + v*v, 0));
  check('quaternion stays unit-length', Math.abs(qLen - 1) < 1e-4, `|q|=${qLen}`);

  // No torque → rotation damps to zero.
  m.omega = [0, 0, 3];
  for (let i = 0; i < 300; i++) m.update(1 / 60, [0, W, 0], null, 8);
  check('rotation damps out without torque', Math.abs(m.omega[2]) < 0.01, `ω_z=${m.omega[2].toFixed(4)}`);

  // setCreatureExtent produces finite non-zero inertia.
  check('inertia x finite and positive', m.inertia[0] > 0 && Number.isFinite(m.inertia[0]));
  check('inertia y finite and positive', m.inertia[1] > 0 && Number.isFinite(m.inertia[1]));
  check('inertia z finite and positive', m.inertia[2] > 0 && Number.isFinite(m.inertia[2]));
}

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
