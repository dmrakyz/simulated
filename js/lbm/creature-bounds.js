/**
 * creature-bounds.js — measure a creature's physical extent.
 *
 * The creature is a tree graph of body parts. To fit a rectangular LBM grid
 * tightly around it we need two things:
 *
 *   1. The axis-aligned bounding box (AABB) — drives the per-axis cell counts
 *      so a thin snake gets a thin grid and a sphere-blob gets a cube.
 *   2. The longest path through the part graph (the "diameter") — a robust
 *      single scalar for the creature's reach (wingtip-to-wingtip, nose-to-tail)
 *      used to choose the finest resolution.
 *
 * Everything here is pure data — no Three.js — so it runs and is unit-tested
 * under plain Node. The BUILD-mode adapter (see toPartList in multi-level.js)
 * converts Three.js node objects into the {position, halfSize} part records
 * this module consumes.
 *
 * Part record shape:
 *   { id, position:[x,y,z], halfSize:[hx,hy,hz], parentId? }
 *
 * `parentId` is optional. When present it defines graph edges for the
 * longest-path computation; when absent we fall back to the AABB diagonal.
 */

const EPS = 1e-9;

export function physDist(a, b) {
  const dx = a.position[0] - b.position[0];
  const dy = a.position[1] - b.position[1];
  const dz = a.position[2] - b.position[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Axis-aligned bounding box over every part's extent.
 * Returns world-space min/max plus convenience width/height/length + center.
 */
export function creatureBounds(parts) {
  if (!parts || parts.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], W: 0, H: 0, L: 0, center: [0, 0, 0] };
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const hs = p.halfSize ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.position[i] - hs[i]);
      max[i] = Math.max(max[i], p.position[i] + hs[i]);
    }
  }
  const W = max[0] - min[0];
  const H = max[1] - min[1];
  const L = max[2] - min[2];
  return {
    min, max, W, H, L,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

/**
 * Longest path (graph diameter) via two-pass BFS.
 *
 * Edges come from `parentId`. If no edges exist (flat part list) the diameter
 * is undefined as a path, so we return the farthest-apart pair of centers as a
 * sensible proxy and flag `disconnected`.
 */
export function creatureDiameter(parts) {
  if (!parts || parts.length === 0) return { span: 0, start: null, end: null, disconnected: true };
  if (parts.length === 1) return { span: 0, start: parts[0].id, end: parts[0].id, disconnected: false };

  const byId = new Map(parts.map((p) => [p.id, p]));
  const adj = new Map(parts.map((p) => [p.id, []]));
  let edgeCount = 0;
  for (const p of parts) {
    if (p.parentId != null && byId.has(p.parentId)) {
      adj.get(p.id).push(p.parentId);
      adj.get(p.parentId).push(p.id);
      edgeCount++;
    }
  }

  // No tree structure → fall back to farthest-pair over centers.
  if (edgeCount === 0) {
    let best = 0, a = parts[0].id, b = parts[0].id;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const d = physDist(parts[i], parts[j]);
        if (d > best) { best = d; a = parts[i].id; b = parts[j].id; }
      }
    }
    return { span: best, start: a, end: b, disconnected: true };
  }

  const bfsFar = (startId) => {
    const dist = new Map([[startId, 0]]);
    const queue = [startId];
    let far = startId, farDist = 0;
    while (queue.length) {
      const u = queue.shift();
      for (const v of adj.get(u)) {
        if (!dist.has(v)) {
          const d = dist.get(u) + physDist(byId.get(u), byId.get(v));
          dist.set(v, d);
          if (d > farDist) { farDist = d; far = v; }
          queue.push(v);
        }
      }
    }
    return { far, farDist };
  };

  const first = bfsFar(parts[0].id);
  const second = bfsFar(first.far);
  return { span: second.farDist, start: first.far, end: second.far, disconnected: false };
}

/**
 * Combined extent measurement used by the grid builder.
 * `span` is the larger of the graph diameter and the AABB diagonal, so a
 * creature whose reach is mostly diagonal is never under-sized.
 */
export function measureCreature(parts) {
  const bounds = creatureBounds(parts);
  const diam = creatureDiameter(parts);
  const diag = Math.sqrt(bounds.W * bounds.W + bounds.H * bounds.H + bounds.L * bounds.L);
  return {
    ...bounds,
    diameter: diam.span,
    span: Math.max(diam.span, diag),
    longest: Math.max(bounds.W, bounds.H, bounds.L, EPS),
  };
}
