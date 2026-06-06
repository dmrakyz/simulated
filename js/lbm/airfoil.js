/**
 * airfoil.js — NACA 4-digit airfoil geometry, chord-normalized (x ∈ [0,1],
 * 0 = leading edge, 1 = trailing edge). All returns are fractions of the chord.
 *
 * A flat plate only makes lift once you tilt it (and stalls early). A cambered
 * airfoil makes lift at zero angle of attack and has a far better lift-to-drag
 * ratio — the rounded leading edge keeps flow attached, the camber turns it.
 * These functions are shared by two consumers that must agree exactly:
 *   • the builder, which lofts the visible wing mesh from the profile, and
 *   • the solid-mask rasterizer, which voxelizes the same profile into the LBM.
 * Because both read the identical camber/thickness here, the shape the user
 * sees is the shape the solver feels — no separate lift formula.
 *
 * Pure math, no Three.js — unit-tested under Node.
 */

/** Half-thickness distribution of a NACA 4-digit section (fraction of chord). */
export function nacaThickness(x, t) {
  if (x <= 0 || x >= 1) return 0;
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
}

/** Mean camber line offset (fraction of chord). m = max camber, p = its position. */
export function nacaCamber(x, m, p) {
  if (m === 0 || p <= 0 || p >= 1) return 0;
  if (x < p) return (m / (p * p)) * (2 * p * x - x * x);
  return (m / ((1 - p) * (1 - p))) * ((1 - 2 * p) + 2 * p * x - x * x);
}

/** True if a point (chord fraction, normal fraction) lies inside the section. */
export function insideAirfoil(cFrac, nFrac, m, p, t) {
  if (cFrac < 0 || cFrac > 1) return false;
  const yc = nacaCamber(cFrac, m, p);
  const yt = nacaThickness(cFrac, t);
  return Math.abs(nFrac - yc) <= yt;
}

/** Max |camber|+thickness over the chord (fraction) — the normal half-envelope. */
export function airfoilHalfEnvelope(m, p, t) {
  let v = 0;
  for (let i = 0; i <= 20; i++) {
    const x = i / 20;
    v = Math.max(v, Math.abs(nacaCamber(x, m, p)) + nacaThickness(x, t));
  }
  return v;
}

/**
 * Closed profile polyline for lofting a mesh: upper surface leading→trailing,
 * then lower surface trailing→leading. Coordinates are chord-fraction (x) and
 * normal-fraction (y), both ×chord by the caller.
 */
export function airfoilProfile(m, p, t, n = 28) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    pts.push([x, nacaCamber(x, m, p) + nacaThickness(x, t)]); // upper
  }
  for (let i = n - 1; i >= 1; i--) {
    const x = i / n;
    pts.push([x, nacaCamber(x, m, p) - nacaThickness(x, t)]); // lower (back to LE)
  }
  return pts;
}
