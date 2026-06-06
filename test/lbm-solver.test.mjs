/**
 * Headless physical-correctness tests for the D3Q19 LBM level + solid mask.
 * Run: node test/lbm-solver.test.mjs
 *
 * Covers plan verification items:
 *   A — solid plate at angle of attack in a flow develops a net transverse force
 *   (plus mass conservation, quiescence, rasterization sanity)
 */

import { LbmLevel } from '../js/lbm/level.js';
import { allocMask, buildMask, rasterizePart, flatIdx, SOLID } from '../js/lbm/solid-mask.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}  ${detail}`); }
}

/* ── rasterization ────────────────────────────────────────────────── */
console.log('\n[mask] rasterization');
{
  const dims = [10, 10, 10];
  const mask = allocMask(dims);
  // A box centered in a 1 m³ grid (dx=0.1), half-size 0.15 → ~3 cells across.
  rasterizePart(mask, { position: [0.5, 0.5, 0.5], halfSize: [0.15, 0.15, 0.15], velocity: [1, 0, 0] }, [0, 0, 0], 0.1);
  check('some cells marked solid', mask.count > 0, `count=${mask.count}`);
  check('center cell is solid', mask.solid[flatIdx(5, 5, 5, dims)] === SOLID);
  check('corner cell stays fluid', mask.solid[flatIdx(0, 0, 0, dims)] === 0);
  check('wall velocity stored on solid cell', mask.wallVel[flatIdx(5, 5, 5, dims) * 3] === 1);
}

/* ── flat-plane wing gets minimum thickness (the lift bug fix) ─────── */
console.log('\n[mask] flat plane wing gets solid cells');
{
  const dx = 0.1;
  const dims = [20, 20, 20];
  const mask = allocMask(dims);
  // PlaneGeometry gives halfSize ≈ [0.7, 0.45, 0] — zero in the normal axis.
  // The fix: pad every axis to at least dx so the plane rasterizes as a slab.
  rasterizePart(mask, { position: [1.0, 1.0, 1.0], halfSize: [0.7, 0.45, 0.0], velocity: [0, 0, 0] }, [0, 0, 0], dx);
  check('flat wing (halfSize z=0) still marks solid cells', mask.count > 0, `count=${mask.count}`);
  // The center cell in z should be solid even though the original halfSize was 0.
  const ci = Math.round(1.0 / dx), cj = Math.round(1.0 / dx), ck = Math.round(1.0 / dx);
  check('wing center cell is solid after padding', mask.solid[flatIdx(ci, cj, ck, dims)] === SOLID, `solid[${ci},${cj},${ck}]`);
}

/* ── mass conservation + quiescence ───────────────────────────────── */
console.log('\n[D] quiescent fluid stays still & mass-stable');
{
  const lvl = new LbmLevel([12, 12, 12], 0.1, { tau: 0.6 });
  const m0 = lvl.totalMass();
  for (let s = 0; s < 50; s++) lvl.step([0, 0, 0], null);
  const m1 = lvl.totalMass();
  check('mass conserved with no inlet (<0.5%)', Math.abs(m1 - m0) / m0 < 0.005, `${m0} → ${m1}`);
  let umax = 0;
  for (let c = 0; c < lvl.n; c++) umax = Math.max(umax, Math.hypot(lvl.ux[c], lvl.uy[c], lvl.uz[c]));
  check('velocity stays ~zero (<1e-3)', umax < 1e-3, `umax=${umax}`);
}

/* ── uniform inlet drives uniform flow ────────────────────────────── */
console.log('\n[flow] inlet establishes far-field flow');
{
  const lvl = new LbmLevel([16, 12, 12], 0.1, { tau: 0.6 });
  const U = [0.05, 0, 0];
  for (let s = 0; s < 200; s++) lvl.step(U, null);
  // Sample interior cell.
  const c = lvl.idx(8, 6, 6);
  check('interior u_x approaches inlet (within 20%)', Math.abs(lvl.ux[c] - 0.05) < 0.01, `ux=${lvl.ux[c].toFixed(4)}`);
  check('flow stayed stable (finite)', Number.isFinite(lvl.ux[c]) && lvl.rho[c] > 0.5, `rho=${lvl.rho[c]}`);
}

/* ── A: inclined plate develops transverse (lift) force ───────────── */
console.log('\n[A] inclined plate in flow → net transverse force');
{
  const dims = [40, 28, 12];
  const dx = 0.05;
  const lvl = new LbmLevel(dims, dx, { tau: 0.65 });
  const origin = [0, 0, 0];
  const mask = allocMask(dims);

  // Build a thin plate inclined ~20° in the x–y plane out of stacked boxes,
  // spanning z. Each slab is offset in y as x increases → angle of attack.
  const parts = [];
  const cx = dims[0] * dx * 0.5, cy = dims[1] * dx * 0.5, cz = dims[2] * dx * 0.5;
  for (let s = -6; s <= 6; s++) {
    const px = cx + s * dx;
    const py = cy + s * dx * 0.36; // slope → ~20° AoA
    parts.push({ position: [px, py, cz], halfSize: [dx * 0.6, dx * 0.6, cz], velocity: [0, 0, 0] });
  }
  buildMask(mask, parts, origin, dx);
  check('plate rasterized', mask.count > 0, `count=${mask.count}`);

  const U = [0.06, 0, 0]; // horizontal free stream
  let fy = 0;
  for (let s = 0; s < 600; s++) {
    lvl.step(U, mask);
    if (s > 400) {
      // Transverse momentum imparted to fluid near the plate (sampled column).
      let m = 0;
      for (let i = 0; i < dims[0]; i++) {
        const c = lvl.idx(i, Math.floor(cy / dx), Math.floor(cz / dx));
        m += lvl.rho[c] * lvl.uy[c];
      }
      fy += m;
    }
  }
  check('plate deflects flow transversely (nonzero u_y signal)', Math.abs(fy) > 1e-4, `Σρu_y≈${fy.toExponential(2)}`);
  check('simulation remained finite/stable', Number.isFinite(fy));
  console.log(`    transverse signal Σρu_y ≈ ${fy.toExponential(2)} (sign = deflection direction)`);
}

/* ── aerodynamicForce vs fluidMomentum ────────────────────────────── */
console.log('\n[force] perturbation method vs total-momentum');
{
  const lvl = new LbmLevel([16, 12, 12], 0.1, { tau: 0.6 });
  const U = [0.08, 0, 0];
  for (let s = 0; s < 200; s++) lvl.step(U, null);
  // No obstacle: total momentum is large (background flow), perturbation is ~0.
  const total = lvl.fluidMomentum();
  const perturb = lvl.aerodynamicForce(U);
  check('total momentum large in flow direction', Math.abs(total[0]) > 1, `mx=${total[0].toFixed(2)}`);
  check('aerodynamicForce near zero with no obstacle', Math.abs(perturb[0]) < 1, `Δmx=${perturb[0].toExponential(2)}`);
  console.log(`    totalMomentum_x=${total[0].toFixed(1)}  perturbation_x=${perturb[0].toExponential(2)}`);
}

/* ── MEM force gives a physically sane drag coefficient ───────────── */
console.log('\n[accuracy] momentum-exchange drag coefficient is order-1');
{
  // A flat plate perpendicular to the flow is a bluff body with a well-known
  // drag coefficient Cd ≈ 1.1–2.0. If MEM is right, the measured Cd lands there;
  // a 30× error (the old bulk-momentum bug) would show Cd ≈ 30+.
  // Keep the plate small vs the cross-section (~12% blockage) so we recover the
  // free-air drag coefficient rather than a blockage-inflated one.
  const dims = [40, 56, 28];
  const lvl = new LbmLevel(dims, 0.05, { tau: 0.6 });
  const mask = allocMask(dims);
  const U = 0.08; // lattice free-stream along +x
  const ph = 12, pz = 12, j0 = 22, k0 = 8;
  for (let j = j0; j < j0 + ph; j++)
    for (let k = k0; k < k0 + pz; k++) {
      const f = flatIdx(18, j, k, dims);
      mask.solid[f] = SOLID; mask.count++;
    }
  let fxSum = 0, samples = 0;
  for (let s = 0; s < 1000; s++) {
    lvl.step([U, 0, 0], mask);
    if (s > 700) { fxSum += lvl.forceLattice[0]; samples++; }
  }
  const Fx = fxSum / samples;
  const area = ph * pz;             // frontal area in cells²
  const Cd = (2 * Math.abs(Fx)) / (1.0 * area * U * U); // rho_lat = 1
  check('drag points downstream (+x, same sign as flow)', Fx > 0, `Fx=${Fx.toExponential(2)}`);
  check('drag coefficient is order-1 (0.5 < Cd < 4)', Cd > 0.5 && Cd < 4, `Cd=${Cd.toFixed(2)}`);
  console.log(`    flat-plate Cd ≈ ${Cd.toFixed(2)} (textbook ≈ 1.1–2.0)`);
}

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
