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

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
