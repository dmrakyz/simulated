/**
 * Headless tests for the creature-fitted grid math.
 *
 * Pure Node, no browser / WebGPU needed. Run:  node test/lbm-geometry.test.mjs
 *
 * Covers plan verification items:
 *   B — bounding box correct for asymmetric builds
 *   C — grid level dimensions follow the formula and stay self-similar
 *   (plus diameter / sound-speed sanity)
 */

import { measureCreature, creatureBounds, creatureDiameter } from '../js/lbm/creature-bounds.js';
import { buildGridLevels, levelSoundSpeed, DEFAULTS } from '../js/lbm/grid-params.js';

let passed = 0, failed = 0;
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}  ${detail}`); }
}

/* ── Fixtures ─────────────────────────────────────────────────────── */

// Bird-like: 3 m wingspan (x), 0.5 m tall (y), 0.5 m deep (z), chain of parts.
const bird = [
  { id: 'torso', position: [0, 0, 0],    halfSize: [0.25, 0.25, 0.25] },
  { id: 'wingL', position: [-1.25, 0, 0], halfSize: [0.25, 0.05, 0.20], parentId: 'torso' },
  { id: 'wingR', position: [1.25, 0, 0],  halfSize: [0.25, 0.05, 0.20], parentId: 'torso' },
  { id: 'head',  position: [0, 0.1, 0.4], halfSize: [0.12, 0.12, 0.12], parentId: 'torso' },
  { id: 'tail',  position: [0, 0, -0.5],  halfSize: [0.10, 0.05, 0.20], parentId: 'torso' },
];

// Thin snake along z.
const snake = Array.from({ length: 8 }, (_, i) => ({
  id: `seg${i}`, position: [0, 0, i * 0.4], halfSize: [0.12, 0.12, 0.2],
  parentId: i === 0 ? undefined : `seg${i - 1}`,
}));

// Symmetric blob.
const blob = [{ id: 'b', position: [0, 0, 0], halfSize: [0.25, 0.25, 0.25] }];

/* ── B: bounding box ──────────────────────────────────────────────── */
console.log('\n[B] AABB for asymmetric builds');
{
  const b = creatureBounds(bird);
  check('bird width spans both wingtips (~3 m)', approx(b.W, 3.0, 1e-6), `W=${b.W}`);
  check('bird height ~0.5 m', approx(b.H, 0.5, 0.21), `H=${b.H}`); // head lifts top a touch
  check('bird depth covers head→tail', b.L >= 0.9, `L=${b.L}`);
  check('center x centered at 0', approx(b.center[0], 0, 1e-6), `cx=${b.center[0]}`);
  const s = creatureBounds(snake);
  check('snake is thin in x,y but long in z', s.W < 0.5 && s.L > 2.5, `W=${s.W} L=${s.L}`);
}

/* ── diameter ─────────────────────────────────────────────────────── */
console.log('\n[diameter] longest path');
{
  const d = creatureDiameter(bird);
  check('bird diameter is wingtip→wingtip (~2.5 m center span)', d.span >= 2.4 && d.span <= 2.6, `span=${d.span}`);
  const sd = creatureDiameter(snake);
  check('snake diameter ~ full body length', approx(sd.span, 0.4 * 7, 1e-6), `span=${sd.span}`);
  check('single part has zero diameter', creatureDiameter(blob).span === 0);
}

/* ── C: grid levels ───────────────────────────────────────────────── */
console.log('\n[C] grid level construction');
{
  const m = measureCreature(bird);
  const { levels, totalCells, ratio } = buildGridLevels(m);
  check('three levels built', levels.length === 3);
  check('labels FAG/NFF/CWG', levels.map((l) => l.label).join() === 'FAG,NFF,CWG');

  const [fag, nff, cwg] = levels;
  check('Δx grows by RATIO between levels', approx(nff.dx, fag.dx * ratio) && approx(cwg.dx, fag.dx * ratio * ratio));
  check('grid is rectangular, not a cube (x ≫ y for bird)', fag.dims[0] > fag.dims[1] * 2, `dims=${fag.dims}`);
  check('all dims are odd (centered)', levels.every((l) => l.dims.every((n) => n % 2 === 1)));
  check('FAG longest axis ≤ N_MAX', Math.max(...fag.dims) <= DEFAULTS.N_MAX, `dims=${fag.dims}`);

  // Self-similar: coarser levels cover more world at similar cell count.
  check('CWG domain ⊃ FAG domain', cwg.domain[0] > fag.domain[0] * 3, `${cwg.domain[0]} vs ${fag.domain[0]}`);
  check('per-level cell counts within 1.0× of each other (self-similar)',
    Math.max(...levels.map((l) => l.nCells)) <= levels[0].nCells * 1.01, levels.map((l) => l.nCells).join());

  console.log(`    bird grid: FAG ${fag.dims.join('×')} (Δx=${fag.dx.toFixed(3)}m), ` +
    `total ${totalCells.toLocaleString()} cells across 3 levels`);
}

/* ── blob → near-cube ─────────────────────────────────────────────── */
console.log('\n[C2] symmetric creature → near-cube grid');
{
  const { levels } = buildGridLevels(measureCreature(blob));
  const d = levels[0].dims;
  check('blob FAG is a cube (all axes equal)', d[0] === d[1] && d[1] === d[2], `dims=${d}`);
}

/* ── sound speed / Mach ───────────────────────────────────────────── */
console.log('\n[Mach] level sound speed');
{
  const { levels } = buildGridLevels(measureCreature(bird));
  const ss = levelSoundSpeed(levels[0]);
  check('FAG sound speed positive & finite', ss.cs > 0 && Number.isFinite(ss.cs), `cs=${ss.cs}`);
  check('Mach ceiling is 0.4·cs', approx(ss.uMax, 0.4 * ss.cs));
  console.log(`    FAG c_s≈${ss.cs.toFixed(1)} m/s, u_max≈${ss.uMax.toFixed(1)} m/s`);
}

/* ── summary ──────────────────────────────────────────────────────── */
console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
