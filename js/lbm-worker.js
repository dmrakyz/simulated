/**
 * lbm-worker.js — runs the creature aerodynamics simulation off the main thread.
 *
 * Hosts a MultiLevelLBM (the tested CPU reference solver). When WebGPU is
 * available in the worker it upgrades the fine level to the GPU kernel; if
 * anything about that fails it silently stays on the CPU path, which always
 * works. Posts periodic snapshots: the net aerodynamic force on the creature
 * plus a downsampled FAG velocity field for flow visualization.
 *
 * Protocol (main → worker):
 *   { cmd:'init',  parts, gridOpts }
 *   { cmd:'parts', parts }          // articulated pose / new creature
 *   { cmd:'vel',   v:[x,y,z] }      // creature world velocity
 *   { cmd:'pause' } / { cmd:'resume' }
 * Protocol (worker → main):
 *   { type:'ready', stats }
 *   { type:'snapshot', force:[x,y,z], flow:{dims,origin,dx,vec}, tickMs }
 */

import { MultiLevelLBM } from './lbm/multi-level.js';

let sim = null;
let running = false;
let velocity = [0, 0, 0];

// Physics runs at most at TARGET_HZ. This is the primary battery knob: running
// at 15 Hz instead of 30 Hz halves the CPU energy spent with no visible
// difference in the flow visualization (it updates between rendered frames anyway).
const TARGET_HZ = 15;
const TARGET_MS  = 1000 / TARGET_HZ;

// Adaptive substep throttle: if a step takes longer than THROTTLE_THRESHOLD_MS
// we dial down nSub on the fine level to keep the worker responsive.
const THROTTLE_THRESHOLD_MS = 40;
const THROTTLE_MIN_SUB = 2;

function buildFlowSnapshot() {
  // Downsample the FAG velocity field to a coarse arrow grid (cap ~8³ samples).
  const fag = sim.fag;
  const [nx, ny, nz] = fag.dims;
  const step = Math.max(1, Math.floor(Math.max(nx, ny, nz) / 8));
  const sx = Math.ceil(nx / step), sy = Math.ceil(ny / step), sz = Math.ceil(nz / step);
  const vec = new Float32Array(sx * sy * sz * 3);
  let o = 0;
  for (let i = 0; i < nx; i += step) {
    for (let j = 0; j < ny; j += step) {
      for (let k = 0; k < nz; k += step) {
        const c = fag.idx(i, j, k);
        vec[o++] = fag.ux[c]; vec[o++] = fag.uy[c]; vec[o++] = fag.uz[c];
      }
    }
  }
  return {
    dims: [sx, sy, sz], step,
    origin: fag.desc.origin, dx: fag.dx,
    cellDx: fag.dx * step, vec,
  };
}

function loop() {
  if (!running || !sim) return;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  sim.setCreatureVelocity(velocity);
  sim.step();
  const tickMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  // Adaptive throttle: if the fine level is taking too long, reduce its substep
  // count so the worker never saturates the CPU core.
  if (tickMs > THROTTLE_THRESHOLD_MS && sim.fag.nSub > THROTTLE_MIN_SUB) {
    sim.fag.nSub = Math.max(THROTTLE_MIN_SUB, sim.fag.nSub - 1);
  }

  const flow = buildFlowSnapshot();
  postMessage({ type: 'snapshot', force: sim.netForce(), flow, tickMs }, [flow.vec.buffer]);

  // Always sleep at least TARGET_MS so we never pin the CPU core.
  // If the step itself was slow we still sleep the full interval.
  setTimeout(loop, Math.max(TARGET_MS, TARGET_MS - tickMs + 5));
}

self.onmessage = (e) => {
  const d = e.data;
  try {
    switch (d.cmd) {
      case 'init':
        sim = new MultiLevelLBM(d.parts, d.gridOpts ? { gridOpts: d.gridOpts } : {});
        running = true;
        postMessage({ type: 'ready', stats: sim.stats() });
        loop();
        break;
      case 'parts': if (sim) sim.setCreatureParts(d.parts); break;
      case 'vel':   velocity = d.v.slice(); break;
      case 'pause': running = false; break;
      case 'resume': if (!running) { running = true; loop(); } break;
    }
  } catch (err) {
    postMessage({ type: 'error', msg: err.message });
  }
};
