/**
 * Headless tests for the NACA airfoil math + its voxelization into the LBM.
 * Run: node test/lbm-airfoil.test.mjs
 *
 * The decisive physical check: a CAMBERED section develops lift at ZERO angle
 * of attack (a flat plate cannot). That is the whole point of giving wings a
 * real airfoil cross-section instead of a flat plate.
 */

import { nacaThickness, nacaCamber, insideAirfoil, airfoilHalfEnvelope, airfoilProfile } from '../js/lbm/airfoil.js';
import { LbmLevel } from '../js/lbm/level.js';
import { allocMask, buildMask } from '../js/lbm/solid-mask.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}  ${detail}`); }
}

/* ── airfoil math ─────────────────────────────────────────────────── */
console.log('\n[math] NACA section shape');
{
  check('thickness is zero at LE and TE', nacaThickness(0, 0.12) === 0 && nacaThickness(1, 0.12) === 0);
  check('thickness peaks near x≈0.3', nacaThickness(0.3, 0.12) > nacaThickness(0.05, 0.12) && nacaThickness(0.3, 0.12) > nacaThickness(0.8, 0.12));
  check('symmetric section has no camber', nacaCamber(0.5, 0, 0.4) === 0);
  check('positive camber lifts the mean line above chord', nacaCamber(0.4, 0.04, 0.4) > 0);
  check('point on the camber line is inside', insideAirfoil(0.3, nacaCamber(0.3, 0.04, 0.4), 0.04, 0.4, 0.12) === true);
  check('point well above the section is outside', insideAirfoil(0.3, 0.5, 0.04, 0.4, 0.12) === false);
  check('envelope is positive and < 0.5 chord', airfoilHalfEnvelope(0.04, 0.4, 0.12) > 0 && airfoilHalfEnvelope(0.04, 0.4, 0.12) < 0.5);
  const prof = airfoilProfile(0.04, 0.4, 0.12, 16);
  check('profile is a closed-ish loop with both surfaces', prof.length > 16 && prof[0][0] === 0);
}

/* ── cambered airfoil makes lift at 0° AoA ────────────────────────── */
console.log('\n[lift] cambered section lifts at zero angle of attack');
{
  // Match the app frame: forward flight +Z → far field flows in −Z.
  const dims = [24, 44, 60];   // x=span, y=lift, z=chord/flow
  const dx = 0.05;
  const U = [0, 0, -0.08];     // free stream toward −z (LE at +z faces it)
  const center = [dims[0] * dx / 2, dims[1] * dx / 2, dims[2] * dx / 2];
  const spanH = 0.4, chordH = 0.35;
  const m = 0.05, p = 0.4, t = 0.12;
  const envW = airfoilHalfEnvelope(m, p, t) * (chordH * 2);

  const wing = {
    shape: 'airfoil',
    position: center,
    axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], // span X, normal Y(up), chord Z
    halfSize: [spanH, envW, chordH],
    camber: m, camberPos: p, thick: t,
    velocity: [0, 0, 0],
  };

  const lvl = new LbmLevel(dims, dx, { tau: 0.6 });
  const mask = allocMask(dims);
  buildMask(mask, [wing], [0, 0, 0], dx);
  check('airfoil voxelized into solid cells', mask.count > 0, `count=${mask.count}`);

  let fy = 0, fz = 0, ns = 0;
  for (let s = 0; s < 900; s++) {
    lvl.step(U, mask);
    if (s > 650) { fy += lvl.forceLattice[1]; fz += lvl.forceLattice[2]; ns++; }
  }
  fy /= ns; fz /= ns;
  const ld = Math.abs(fy) / (Math.abs(fz) + 1e-9);
  check('lift is nonzero at 0° AoA (camber works)', Math.abs(fy) > 1e-3, `fy=${fy.toExponential(2)}`);
  check('lift points up (+y) for positive camber', fy > 0, `fy=${fy.toExponential(2)}`);
  check('drag points downstream (−z)', fz < 0, `fz=${fz.toExponential(2)}`);
  check('result is finite/stable', Number.isFinite(fy) && Number.isFinite(fz));
  console.log(`    0°-AoA airfoil lift=${fy.toExponential(2)} drag=${fz.toExponential(2)} L/D=${ld.toFixed(2)}`);
}

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
