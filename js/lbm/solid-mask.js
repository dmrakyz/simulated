/**
 * solid-mask.js — rasterize creature body parts into the fine grid (FAG) as
 * solid obstacle cells, and carry each solid cell's wall velocity for moving
 * (Ladd) bounce-back.
 *
 * In the creature's Galilean frame the body is stationary, so the mask only
 * needs rebuilding when an articulated part moves (a flapping wing). Each part
 * is treated as an axis-aligned box in grid space — cheap and good enough for
 * the pressure field that drives lift/drag.
 *
 * Pure typed-array work, no GPU — unit-tested under Node.
 *
 * Part record (grid-agnostic, world units):
 *   { position:[x,y,z], halfSize:[hx,hy,hz], velocity?:[vx,vy,vz] }
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
 * Rasterize one box part into the mask.
 * @param origin world-space min corner of the grid
 * @param dx     cell size
 */
export function rasterizePart(mask, part, origin, dx) {
  const { dims, solid, wallVel } = mask;
  const vel = part.velocity ?? [0, 0, 0];
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const minW = part.position[a] - part.halfSize[a];
    const maxW = part.position[a] + part.halfSize[a];
    lo[a] = Math.max(0, Math.floor((minW - origin[a]) / dx));
    hi[a] = Math.min(dims[a] - 1, Math.ceil((maxW - origin[a]) / dx));
  }
  for (let i = lo[0]; i <= hi[0]; i++) {
    for (let j = lo[1]; j <= hi[1]; j++) {
      for (let k = lo[2]; k <= hi[2]; k++) {
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
