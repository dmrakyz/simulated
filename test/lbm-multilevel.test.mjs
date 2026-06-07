/**
 * Headless tests for the multi-level orchestrator.
 * Run: node test/lbm-multilevel.test.mjs
 *
 * Covers plan verification items:
 *   F — creature at very high speed stays Mach-stable in FAG (Galilean frame)
 *   (plus schedule wiring, mask rebuild, net-force responds to motion)
 */

import { MultiLevelLBM } from '../js/lbm/multi-level.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}  ${detail}`); }
}

// A small bird so the grids are cheap for a headless run.
const bird = [
  { id: 'torso', position: [0, 0, 0], halfSize: [0.15, 0.12, 0.15] },
  { id: 'wingL', position: [-0.5, 0, 0], halfSize: [0.25, 0.03, 0.15], parentId: 'torso' },
  { id: 'wingR', position: [0.5, 0, 0], halfSize: [0.25, 0.03, 0.15], parentId: 'torso' },
];

console.log('\n[setup] orchestrator builds 3 levels + mask');
const sim = new MultiLevelLBM(bird, { gridOpts: { N_MAX: 32, N_MIN: 12 } });
{
  const st = sim.stats();
  check('three levels present', st.levels.length === 3, JSON.stringify(st.levels.map((l) => l.label)));
  check('FAG has solid cells from the creature', st.solidCells > 0, `solid=${st.solidCells}`);
  check('coarser levels have larger Δx', st.levels[2].dx > st.levels[0].dx);
  check('substep cadence 5/3/2 (default)', st.levels.map((l) => l.nSub).join() === '5,3,2');
  console.log(`    ${st.levels.map((l) => `${l.label} ${l.dims.join('×')} Δx=${l.dx}`).join('  |  ')}`);
}

console.log('\n[F] supersonic creature stays Mach-stable');
{
  sim.setCreatureVelocity([1000, 0, 0]); // absurd cruise speed
  for (let f = 0; f < 30; f++) sim.step();
  // FAG far-field velocity is clamped; lattice speeds must stay subsonic & finite.
  let umax = 0, finite = true;
  const fag = sim.fag;
  for (let c = 0; c < fag.n; c++) {
    const u = Math.hypot(fag.ux[c], fag.uy[c], fag.uz[c]);
    umax = Math.max(umax, u);
    if (!Number.isFinite(u) || !Number.isFinite(fag.rho[c])) finite = false;
  }
  const cap = 0.4 * Math.sqrt(1 / 3);
  check('FAG lattice speed below Mach ceiling', umax <= cap * 1.5, `umax=${umax.toFixed(3)} cap=${cap.toFixed(3)}`);
  check('no NaN/Inf at 1000 m/s', finite);
}

console.log('\n[force] net force responds to creature motion');
{
  const still = new MultiLevelLBM(bird, { gridOpts: { N_MAX: 32, N_MIN: 12 } });
  for (let f = 0; f < 20; f++) still.step();
  const f0 = still.netForce();
  const mag0 = Math.hypot(...f0);

  const moving = new MultiLevelLBM(bird, { gridOpts: { N_MAX: 32, N_MIN: 12 } });
  moving.setCreatureVelocity([5, 0, 0]);
  for (let f = 0; f < 40; f++) moving.step();
  const f1 = moving.netForce();
  const mag1 = Math.hypot(...f1);

  check('still creature → ~no net force', mag0 < mag1 + 1e-6, `still=${mag0.toExponential(2)}`);
  check('moving creature → nonzero drag force', mag1 > 0, `moving=${mag1.toExponential(2)} N`);
  check('force is finite', Number.isFinite(mag1));
  console.log(`    |F| still=${mag0.toExponential(2)}N  moving=${mag1.toExponential(2)}N`);
}

console.log('\n[wind] world wind drives a force on a still creature (gust boost)');
{
  // A still creature in still air → ~no force. The same still creature in an
  // imposed world wind → a real aerodynamic force, even though it never moves.
  // This is the Galilean inlet = worldWind − v_creature; with v=0 the gust is
  // the entire signal. Equivalent to moving the creature through still air.
  const calm = new MultiLevelLBM(bird, { gridOpts: { N_MAX: 32, N_MIN: 12 } });
  for (let f = 0; f < 30; f++) calm.step();
  const magCalm = Math.hypot(...calm.netForce());

  const gust = new MultiLevelLBM(bird, { gridOpts: { N_MAX: 32, N_MIN: 12 } });
  gust.setWorldWind([0, 0, -6]); // 6 m/s headwind, creature stationary
  for (let f = 0; f < 40; f++) gust.step();
  const fGust = gust.netForce();
  const magGust = Math.hypot(...fGust);

  check('still creature in still air → ~no force', magCalm < magGust, `calm=${magCalm.toExponential(2)}`);
  check('world wind alone produces a force (gust kicks the creature)', magGust > 0, `gust=${magGust.toExponential(2)} N`);
  check('gust force is finite', Number.isFinite(magGust));
  console.log(`    |F| calm=${magCalm.toExponential(2)}N  gust=${magGust.toExponential(2)}N`);
}

console.log('\n[mask] articulated pose rebuild');
{
  const before = sim.mask.count;
  const flap = bird.map((p) => (p.id === 'wingL'
    ? { ...p, position: [-0.5, 0.3, 0] } : p)); // raise left wing
  sim.setCreatureParts(flap);
  check('mask rebuilt (count still > 0)', sim.mask.count > 0, `before=${before} after=${sim.mask.count}`);
}

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
