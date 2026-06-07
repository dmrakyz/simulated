/**
 * AeroController — main-thread handle to the creature aerodynamics simulation.
 *
 * Mirrors SimController's design: prefer a Web Worker, fall back transparently
 * to running MultiLevelLBM on the main thread. The render side only reads
 * `controller.force` and `controller.flow`; it doesn't care which backend runs.
 *
 * This is additive — it sits alongside the existing MPM particle world and is
 * activated only in SIMULATE mode when a creature exists. It never touches the
 * MPM solver, so the working WORLD/BUILD experience is unaffected.
 */

import { MultiLevelLBM, nodesToParts } from './lbm/multi-level.js';

export class AeroController {
  constructor() {
    this.worker = null;
    this.sim = null;          // main-thread fallback instance
    this.isWorker = false;
    this.active = false;
    this.force = [0, 0, 0];
    this.torque = [0, 0, 0];
    this.flow = null;
    this.stats = null;
    this.tickMs = 0;
    this._vel = [0, 0, 0];
    this._wind = [0, 0, 0];   // ambient world wind (persists across restarts)
  }

  /** Begin simulating the given creature parts. Returns 'worker' | 'main'. */
  async start(parts, gridOpts = null) {
    this.stop();
    try {
      const worker = new Worker(new URL('./lbm-worker.js', import.meta.url), { type: 'module' });
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('aero worker init timeout')), 5000);
        worker.onmessage = (e) => {
          if (e.data?.type === 'ready') { clearTimeout(to); this.stats = e.data.stats; resolve(); }
          else if (e.data?.type === 'error') { clearTimeout(to); reject(new Error(e.data.msg)); }
        };
        worker.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || 'aero worker error')); };
        worker.postMessage({ cmd: 'init', parts, gridOpts });
      });
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'snapshot') { this.force = m.force; this.torque = m.torque ?? [0,0,0]; this.flow = m.flow; this.tickMs = m.tickMs; }
        else if (m.type === 'error') console.error('Aero worker:', m.msg);
      };
      this.worker = worker;
      this.isWorker = true;
      this.active = true;
      this.setWorldWind(this._wind);   // re-apply any wind set before start
      return 'worker';
    } catch (e) {
      console.warn('Aero worker unavailable — running on main thread:', e.message);
      this.sim = new MultiLevelLBM(parts, gridOpts ? { gridOpts } : {});
      this.stats = this.sim.stats();
      this.isWorker = false;
      this.active = true;
      this.setWorldWind(this._wind);
      return 'main';
    }
  }

  setParts(parts) {
    if (!this.active) return;
    if (this.isWorker) this.worker.postMessage({ cmd: 'parts', parts });
    else this.sim.setCreatureParts(parts);
  }

  setVelocity(v) {
    this._vel = v.slice();
    if (this.isWorker && this.active) this.worker.postMessage({ cmd: 'vel', v });
  }

  /** Set the ambient world wind (m/s) feeding the Galilean inlet (incl. gusts). */
  setWorldWind(w) {
    this._wind = w.slice();
    if (!this.active) return;
    if (this.isWorker) this.worker.postMessage({ cmd: 'wind', w });
    else if (this.sim) this.sim.setWorldWind(w);
  }

  /** Main-thread fallback advance (no-op under the worker). Call once/frame. */
  stepLocal() {
    if (this.isWorker || !this.sim || !this.active) return;
    this.sim.setCreatureVelocity(this._vel);
    this.sim.step();
    this.force = this.sim.netForce();
    this.torque = this.sim.netTorque();
    // Build a light flow snapshot inline (same downsampling as the worker).
    const fag = this.sim.fag, [nx, ny, nz] = fag.dims;
    const step = Math.max(1, Math.floor(Math.max(nx, ny, nz) / 8));
    const sx = Math.ceil(nx / step), sy = Math.ceil(ny / step), sz = Math.ceil(nz / step);
    const vec = new Float32Array(sx * sy * sz * 3);
    let o = 0;
    for (let i = 0; i < nx; i += step)
      for (let j = 0; j < ny; j += step)
        for (let k = 0; k < nz; k += step) {
          const c = fag.idx(i, j, k);
          vec[o++] = fag.ux[c]; vec[o++] = fag.uy[c]; vec[o++] = fag.uz[c];
        }
    // Creature-relative origin (see lbm-worker.js): the renderer pins the field
    // to the creature's live position, so the grid corner is given about the body.
    const origin = [-nx * fag.dx / 2, -ny * fag.dx / 2, -nz * fag.dx / 2];
    this.flow = { dims: [sx, sy, sz], step, origin, dx: fag.dx, cellDx: fag.dx * step, vec };
  }

  stop() {
    if (this.worker) { try { this.worker.terminate(); } catch (_) {} this.worker = null; }
    this.sim = null;
    this.active = false;
    this.force = [0, 0, 0];
    this.flow = null;
  }

  /**
   * Build oriented part records from CreatureBuilder nodes (Three.js graph).
   * Reads each mesh's current world transform, so any wing tilt the user has
   * applied (angle of attack, dihedral, sweep) drives the flow directly.
   */
  static partsFromBuilder(builder, THREE) {
    if (!builder || !builder.nodes) return [];
    const nodes = [];
    for (const n of builder.nodes.values()) nodes.push({ id: n.id, type: n.type, obj: n.obj, parentId: null, airfoil: n.airfoil ?? null });
    return nodesToParts(nodes, THREE);
  }
}
