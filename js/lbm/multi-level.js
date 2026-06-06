/**
 * multi-level.js — orchestrates the three creature-fitted LBM levels
 * (FAG / NFF / CWG) in the creature's Galilean frame.
 *
 * Responsibilities:
 *   • build the level stack from a measured creature (grid-params)
 *   • rasterize the creature into the fine grid (solid-mask)
 *   • run the per-level substep schedule each frame (loose coupling)
 *   • maintain the smoothed Galilean inlet velocity (−v_creature)
 *   • expose macroscopic fields for the renderer and a net force for gameplay
 *
 * The heavy numerics live in LbmLevel (CPU) or the WGSL kernel (GPU); this file
 * is backend-agnostic glue. The `stepFn` indirection lets the worker swap in a
 * GPU step without changing the schedule. Pure enough to unit-test under Node.
 */

import { measureCreature } from './creature-bounds.js';
import { buildGridLevels, levelSoundSpeed } from './grid-params.js';
import { LbmLevel } from './level.js';
import { allocMask, buildMask } from './solid-mask.js';

export class MultiLevelLBM {
  /**
   * @param parts creature part records [{id,position,halfSize,velocity?,parentId?}]
   * @param opts  { fps, gridOpts, LevelClass }
   */
  constructor(parts, opts = {}) {
    this.fps = opts.fps ?? 60;
    this.measure = measureCreature(parts);
    const built = buildGridLevels(this.measure, opts.gridOpts);
    this.ratio = built.ratio;

    const Level = opts.LevelClass ?? LbmLevel;
    this.levels = built.levels.map((desc) => {
      // Physical air viscosity gives an almost-inviscid lattice ν, which puts
      // τ right at the 0.5 stability edge. Floor τ at 0.55 (a small numerical
      // bulk viscosity) so omega stays comfortably below 2 — robustness over a
      // tiny accuracy loss, the right trade for a game.
      const tau = 0.5 + 3 * kinematicToLatticeNu(desc, this.fps);
      const lvl = new Level(desc.dims, desc.dx, {
        tau: Math.max(0.55, Math.min(1.2, tau)),
        label: desc.label,
        level: desc.level,
        origin: desc.origin,
      });
      lvl.desc = desc;
      lvl.nSub = desc.nSub;
      lvl.sound = levelSoundSpeed(desc, this.fps);
      return lvl;
    });

    // Solid mask only on the finest level (FAG).
    this.fag = this.levels[0];
    this.mask = allocMask(this.fag.dims);
    this.setCreatureParts(parts);

    // Smoothed Galilean far-field velocity (m/s) to suppress acoustic ringing.
    this.uSmooth = [0, 0, 0];
    this.vCreature = [0, 0, 0];
    // EMA-smoothed body force (lattice units) — kills frame-to-frame jitter in
    // the displayed lift/drag without lagging perceptibly.
    this.forceEMA = [0, 0, 0];
    this.torqueEMA = [0, 0, 0];
  }

  /** Rebuild the fine-grid solid mask from the current articulated pose. */
  setCreatureParts(parts) {
    this.parts = parts;
    buildMask(this.mask, parts, this.fag.desc.origin, this.fag.dx);
  }

  /** Set the creature's world velocity; the frame inlet is −v (smoothed). */
  setCreatureVelocity(v) { this.vCreature = v.slice(); }

  /** Convert a physical velocity (m/s) to a level's lattice velocity. */
  toLatticeVel(level, vPhys) {
    const { dt } = level.sound;
    const s = dt / level.dx;
    return [-vPhys[0] * s, -vPhys[1] * s, -vPhys[2] * s]; // inlet = −v_creature
  }

  /**
   * Advance one rendered frame. Loose coupling: each level runs its own substep
   * count; coarse→fine boundary feeding and fine→coarse force injection happen
   * once per frame (sufficient for a game; error is O(Δt_frame)).
   */
  step() {
    // Smooth the frame's far-field velocity.
    for (let a = 0; a < 3; a++) this.uSmooth[a] = 0.95 * this.uSmooth[a] + 0.05 * this.vCreature[a];

    // Run coarsest → finest so coarse state is ready to feed finer inlets.
    for (let lv = this.levels.length - 1; lv >= 0; lv--) {
      const level = this.levels[lv];
      const inlet = this.toLatticeVel(level, this.uSmooth);
      // Clamp to the Mach-stable ceiling for this level.
      const cap = 0.4 * Math.sqrt(1 / 3);
      const mag = Math.hypot(inlet[0], inlet[1], inlet[2]);
      if (mag > cap) { const s = cap / mag; inlet[0] *= s; inlet[1] *= s; inlet[2] *= s; }

      const mask = lv === 0 ? this.mask : null;
      let fx = 0, fy = 0, fz = 0;
      let tx = 0, ty = 0, tz = 0;
      for (let s = 0; s < level.nSub; s++) {
        if (level.stepGPU) level.stepGPU(inlet, mask);
        else level.step(inlet, mask);
        if (lv === 0) {
          fx += level.forceLattice[0]; fy += level.forceLattice[1]; fz += level.forceLattice[2];
          tx += level.torqueLattice[0]; ty += level.torqueLattice[1]; tz += level.torqueLattice[2];
        }
      }
      // Average the fine-level force over its substeps, then EMA across frames.
      if (lv === 0 && level.nSub > 0) {
        const inv = 1 / level.nSub, a = 0.15;
        this.forceEMA[0] = (1 - a) * this.forceEMA[0] + a * fx * inv;
        this.forceEMA[1] = (1 - a) * this.forceEMA[1] + a * fy * inv;
        this.forceEMA[2] = (1 - a) * this.forceEMA[2] + a * fz * inv;
        this.torqueEMA[0] = (1 - a) * this.torqueEMA[0] + a * tx * inv;
        this.torqueEMA[1] = (1 - a) * this.torqueEMA[1] + a * ty * inv;
        this.torqueEMA[2] = (1 - a) * this.torqueEMA[2] + a * tz * inv;
      }
    }
  }

  /**
   * Net aerodynamic force on the creature (N), via the momentum-exchange method
   * (a surface integral at the body), EMA-smoothed across frames.
   *
   * Lattice→physical force conversion: a lattice force has units of
   * (Δm·Δx/Δt²). With Δm = ρ_air·Δx³ and the level's physical Δt:
   *   F_phys = F_lattice · ρ_air · Δx⁴ / Δt²
   */
  netForce(rhoAir = 1.225) {
    const dx = this.fag.dx;
    const { dt } = this.fag.sound;
    const k = (rhoAir * dx * dx * dx * dx) / (dt * dt);
    return [this.forceEMA[0] * k, this.forceEMA[1] * k, this.forceEMA[2] * k];
  }

  /**
   * Net aerodynamic torque on the creature (N·m) about the FAG grid centre.
   * Same conversion as netForce() since r is already in physical metres in the
   * torque accumulation (so the factor is the same: rhoAir·dx⁴/dt²).
   */
  netTorque(rhoAir = 1.225) {
    const dx = this.fag.dx;
    const { dt } = this.fag.sound;
    const k = (rhoAir * dx * dx * dx * dx) / (dt * dt);
    return [this.torqueEMA[0] * k, this.torqueEMA[1] * k, this.torqueEMA[2] * k];
  }

  /** Compact stats for HUD / debugging. */
  stats() {
    return {
      levels: this.levels.map((l) => ({
        label: l.label, dims: l.dims, dx: +l.dx.toFixed(4), nSub: l.nSub,
        cs: +l.sound.cs.toFixed(2), nCells: l.n,
      })),
      totalCells: this.levels.reduce((s, l) => s + l.n, 0),
      solidCells: this.mask.count,
    };
  }
}

/** Physical kinematic viscosity of air → lattice ν for a level's Δx,Δt. */
function kinematicToLatticeNu(desc, fps) {
  const NU_AIR = 1.5e-5; // m²/s
  const dt = 1 / (fps * desc.nSub);
  return (NU_AIR * dt) / (desc.dx * desc.dx);
}

/**
 * Adapter: convert CreatureBuilder Three.js nodes → ORIENTED part records.
 * Needs THREE for matrix math. Kept here so the worker/main can call it; the
 * math modules above stay Three-free and headless-testable.
 *
 * Each mesh becomes one oriented box (OBB): its local geometry bounding box,
 * placed at its world position with its world rotation. This preserves the
 * inclined surface of a tilted wing (the source of lift) instead of collapsing
 * it into an axis-aligned bounding brick. A chain (Group of meshes, e.g. a
 * spine) yields one OBB per segment.
 *
 * @param nodes iterable of { id, type, obj, parentId? } (obj = Object3D)
 * @param THREE the three.js module
 */
export function nodesToParts(nodes, THREE) {
  const center = new THREE.Vector3();
  const parts = [];
  for (const n of nodes) {
    n.obj.updateWorldMatrix(true, true);
    let sub = 0;
    n.obj.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const geo = o.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const lhx = (bb.max.x - bb.min.x) / 2;
      const lhy = (bb.max.y - bb.min.y) / 2;
      const lhz = (bb.max.z - bb.min.z) / 2;

      // World basis columns of the mesh matrix; their lengths are the scales.
      const m = o.matrixWorld.elements;
      const sx = Math.hypot(m[0], m[1], m[2]) || 1;
      const sy = Math.hypot(m[4], m[5], m[6]) || 1;
      const sz = Math.hypot(m[8], m[9], m[10]) || 1;
      const axes = [
        [m[0] / sx, m[1] / sx, m[2] / sx],
        [m[4] / sy, m[5] / sy, m[6] / sy],
        [m[8] / sz, m[9] / sz, m[10] / sz],
      ];

      // World center = mesh world matrix applied to the local bbox center.
      center.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2);
      center.applyMatrix4(o.matrixWorld);

      const part = {
        id: sub === 0 ? n.id : `${n.id}:${sub}`,
        parentId: n.parentId ?? null,
        position: [center.x, center.y, center.z],
        halfSize: [lhx * sx, lhy * sy, lhz * sz],
        axes,
        velocity: n.velocity ?? [0, 0, 0],
        type: n.type,
      };
      // Wings/fins carry a NACA section that voxelizes as a real airfoil
      // (span = local X, normal = local Y, chord = local Z) instead of a slab.
      if (n.airfoil) {
        part.shape = 'airfoil';
        part.camber = n.airfoil.m;
        part.camberPos = n.airfoil.p;
        part.thick = n.airfoil.t;
      }
      parts.push(part);
      sub++;
    });
  }
  return parts;
}
