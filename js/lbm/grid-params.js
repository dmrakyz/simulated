/**
 * grid-params.js — derive the three nested LBM grid levels from a creature's
 * measured extent.
 *
 * Idea: instead of a fixed cube, fit a rectangular grid to the creature's
 * actual bounding box, then decay resolution outward in self-similar shells:
 *
 *   FAG  (L0, fine)   — hugs the body, captures the wing surface
 *   NFF  (L1, near)   — RATIO× coarser & larger, the immediate wake
 *   CWG  (L2, world)  — RATIO² coarser, the shared far field
 *
 * Each level keeps roughly the same cell count, so total cost is ~3× a single
 * level while covering RATIO² more space. A thin creature yields a thin grid
 * (few cells wasted on empty air); a round one yields a near-cube.
 *
 * Pure data, no GPU — unit-tested under Node.
 */

export const DEFAULTS = {
  N_MAX: 64,    // max cells per axis at L0 — 64 gives good wing detail without melting phones
  N_MIN: 16,    // floor so tiny creatures still get a usable grid
  DX_MIN: 0.02, // finest resolution, 2 cm
  DX_MAX: 2.0,  // coarsest L0 resolution
  PAD: 0.35,    // fractional margin of air around the creature at L0
  RATIO: 4,     // refinement ratio between consecutive levels
  N_SUB: [5, 3, 2], // substeps/frame — enough for a game, won't kill a phone battery
  LABELS: ['FAG', 'NFF', 'CWG'],
};

/** Round up to an odd integer (keeps a symmetric creature centered on a cell). */
function ceilOdd(x) {
  let n = Math.ceil(x);
  if (n % 2 === 0) n += 1;
  return n;
}

/** Odd cell count clamped to [lo, hi]; both bounds are rounded to odd. */
function oddClamp(x, lo, hi) {
  const loOdd = lo % 2 === 0 ? lo + 1 : lo; // ensure floor is also odd
  const hiOdd = hi % 2 === 0 ? hi - 1 : hi;
  return Math.min(hiOdd, Math.max(loOdd, ceilOdd(x)));
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/**
 * Build the level descriptors.
 *
 * @param measure  output of measureCreature(): { W, H, L, longest, center }
 * @param opts     optional overrides of DEFAULTS
 * @returns        { levels:[{label,dx,dims,domain,nCells,nSub,origin}], totalCells, ratio }
 */
export function buildGridLevels(measure, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { W = 0, H = 0, L = 0, center = [0, 0, 0] } = measure;
  const longest = Math.max(measure.longest ?? Math.max(W, H, L), o.DX_MIN);

  // L0 resolution: fit the *padded* longest axis into N_MAX cells so the grid
  // (including its air margin) never exceeds the budget, clamped to sane Δx.
  const dx0 = clamp((longest * (1 + o.PAD)) / o.N_MAX, o.DX_MIN, o.DX_MAX);

  // L0 per-axis cell counts: padded, odd, in [N_MIN, N_MAX].
  const padded = [W, H, L].map((d) => d * (1 + o.PAD));
  const n0 = padded.map((d) => oddClamp(d / dx0, o.N_MIN, o.N_MAX));

  const levels = [];
  for (let lv = 0; lv < 3; lv++) {
    // Each coarser level is RATIO× coarser in Δx. Cell counts stay near the L0
    // budget (clamped to N_MIN), so the domain grows by ~RATIO per axis per
    // level while the cost per level stays roughly constant — self-similar shells.
    const dx = dx0 * Math.pow(o.RATIO, lv);
    const dims = lv === 0 ? n0.slice() : n0.map((n) => oddClamp(n, o.N_MIN, o.N_MAX));
    const domain = dims.map((n) => n * dx);
    const nCells = dims[0] * dims[1] * dims[2];

    levels.push({
      label: o.LABELS[lv],
      level: lv,
      dx,
      dims,
      domain,
      nCells,
      nSub: o.N_SUB[lv] ?? 1,
      // World-space origin (min corner) keeping the creature centered.
      origin: [
        center[0] - domain[0] / 2,
        center[1] - domain[1] / 2,
        center[2] - domain[2] / 2,
      ],
    });
  }

  const totalCells = levels.reduce((s, l) => s + l.nCells, 0);
  return { levels, totalCells, ratio: o.RATIO, dx0 };
}

/**
 * Lattice sound speed for a level given its Δx and the substep cadence.
 * In lattice units c_s = 1/√3 cells/step; converting to physical units:
 *   c_s_phys = (Δx / Δt) / √3 ,  with Δt = 1 / (fps * nSub).
 * The Mach-stable velocity ceiling is ~0.4 · c_s_phys.
 */
export function levelSoundSpeed(level, fps = 60) {
  const dt = 1 / (fps * level.nSub);
  const cs = (level.dx / dt) / Math.sqrt(3);
  return { dt, cs, uMax: 0.4 * cs };
}
