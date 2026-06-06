/**
 * solid-mask.js — rasterize creature body parts into the fine grid (FAG) as
 * solid obstacle cells, and carry each solid cell's wall velocity for moving
 * (Ladd) bounce-back.
 *
 * In the creature's Galilean frame the body is stationary, so the mask only
 * needs rebuilding when an articulated part moves (a flapping wing).
 *
 * Each part is an ORIENTED box (OBB): a center, three half-extents, and three
 * orthonormal axes (the part's real world rotation). This is the difference
 * between lift and no lift — a wing tilted to an angle of attack must rasterize
 * as a thin INCLINED sheet, not as the axis-aligned bounding brick of that
 * sheet. A brick is thin in no axis, so flow hits a flat face → pure drag and
 * zero lift. The OBB preserves the inclined surface that deflects flow and
 * produces a pressure difference (→ lift). The shape drives the physics
 * directly; there is no separate lift/drag formula.
 *
 * Pure typed-array work, no GPU — unit-tested under Node.
 *
 * Part record (grid-agnostic, world units):
 *   { position:[x,y,z], halfSize:[hx,hy,hz], axes?:[[ax],[ay],[az]], velocity?:[vx,vy,vz] }
 *   `axes` are the (normalized) local box axes in world space. Omitted = identity
 *   (axis-aligned), which keeps older callers and tests working unchanged.
 */

export const FLUID = 0;
export const SOLID = 1;

export function flatIdx(i, j, k, dims) {
  return (i * dims[1] + j) * dims[2] + k;
}

/** Allocate the mask + per-cell wall-velocity buffers for a level. */
export function allocMask(dims) {
  const n = dims[0] * dims[1] * dims[2];
  return {
    dims,
    solid: new Uint8Array(n),       // FLUID / SOLID
    wallVel: new Float32Array(n * 3), // wall velocity per solid cell (m/s)
    count: 0,
  };
}

/** Clear a mask back to all-fluid (reused between rebuilds, no realloc). */
export function clearMask(mask) {
  mask.solid.fill(FLUID);
  mask.wallVel.fill(0);
  mask.count = 0;
}

/**
 * Rasterize one oriented-box part into the mask.
 * @param origin world-space min corner of the grid (node 0,0,0 sits here)
 * @param dx     cell size
 *
 * Thin parts (planes — wings, fins) have a near-zero half-extent in their
 * normal axis. We pad every half-extent to at least `dx` so the part always
 * occupies a watertight ~2-cell-thick sheet; that is the minimum needed to
 * carry a pressure difference (high-pressure windward, low-pressure leeward).
 * The padding is applied along the LOCAL axes, so a tilted wing stays thin
 * perpendicular to its own surface — it does not bloat into a brick.
 */
export function rasterizePart(mask, part, origin, dx) {
  const { dims, solid, wallVel } = mask;
  const vel = part.velocity ?? [0, 0, 0];
  const c = part.position;
  const axes = part.axes ?? null;
  // Padded half-extents along the part's local axes.
  const h0 = Math.max(part.halfSize[0], dx);
  const h1 = Math.max(part.halfSize[1], dx);
  const h2 = Math.max(part.halfSize[2], dx);

  // World-space AABB of the (padded) OBB → the cell range to scan.
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const ext = axes
      ? Math.abs(axes[0][a]) * h0 + Math.abs(axes[1][a]) * h1 + Math.abs(axes[2][a]) * h2
      : (a === 0 ? h0 : a === 1 ? h1 : h2);
    lo[a] = Math.max(0, Math.floor((c[a] - ext - origin[a]) / dx));
    hi[a] = Math.min(dims[a] - 1, Math.ceil((c[a] + ext - origin[a]) / dx));
  }

  for (let i = lo[0]; i <= hi[0]; i++) {
    const px = origin[0] + i * dx;
    for (let j = lo[1]; j <= hi[1]; j++) {
      const py = origin[1] + j * dx;
      for (let k = lo[2]; k <= hi[2]; k++) {
        const pz = origin[2] + k * dx;
        // Inside test: project the cell node onto the part's local axes.
        let inside;
        if (axes) {
          const ex = px - c[0], ey = py - c[1], ez = pz - c[2];
          const q0 = axes[0][0] * ex + axes[0][1] * ey + axes[0][2] * ez;
          const q1 = axes[1][0] * ex + axes[1][1] * ey + axes[1][2] * ez;
          const q2 = axes[2][0] * ex + axes[2][1] * ey + axes[2][2] * ez;
          inside = Math.abs(q0) <= h0 && Math.abs(q1) <= h1 && Math.abs(q2) <= h2;
        } else {
          inside = Math.abs(px - c[0]) <= h0 && Math.abs(py - c[1]) <= h1 && Math.abs(pz - c[2]) <= h2;
        }
        if (!inside) continue;
        const f = flatIdx(i, j, k, dims);
        if (solid[f] === FLUID) mask.count++;
        solid[f] = SOLID;
        wallVel[f * 3] = vel[0];
        wallVel[f * 3 + 1] = vel[1];
        wallVel[f * 3 + 2] = vel[2];
      }
    }
  }
  return mask;
}

/** Rebuild the whole mask from a fresh part list. */
export function buildMask(mask, parts, origin, dx) {
  clearMask(mask);
  for (const p of parts) rasterizePart(mask, p, origin, dx);
  return mask;
}
