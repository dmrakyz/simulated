/**
 * Physics Web Worker — runs the MLS-MPM solver off the main thread so the
 * UI, camera and rendering stay responsive even at very high particle counts.
 *
 * Protocol (main → worker):
 *   { cmd:'init', opts }            create the engine
 *   { cmd:'spawnBox', args:[...] }  spawn a box of particles
 *   { cmd:'reset' }                 clear all particles
 *   { cmd:'setGravity', v }
 *   { cmd:'setSubsteps', v }
 *   { cmd:'pause' } / { cmd:'resume' }
 *   { cmd:'returnBuf', buf }        recycle a transferred snapshot buffer
 *
 * Protocol (worker → main):
 *   { type:'ready' }
 *   { type:'snapshot', count, buf, tickMs }   buf = Float32Array stride 4
 *                                              [x, y, z, matId] per particle
 *   { type:'error', msg }
 */

import { MPM } from './mpm.js';

let mpm      = null;
let running  = false;
let freeBuf  = null;   // ArrayBuffer recycled by the main thread
let lastTick = 8;

/* Build a compact render snapshot (stride 4: x, y, z, matId). */
function buildSnapshot() {
  const n    = mpm.nP;
  const need = n * 4 * 4;          // n particles × 4 floats × 4 bytes
  let f32;
  if (freeBuf && freeBuf.byteLength === need) {
    f32 = new Float32Array(freeBuf);
    freeBuf = null;
  } else {
    f32 = new Float32Array(n * 4);
  }
  const { px, py, pz, pMt } = mpm;
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    f32[o]   = px[p];
    f32[o+1] = py[p];
    f32[o+2] = pz[p];
    f32[o+3] = pMt[p];
  }
  return f32;
}

function loop() {
  if (!mpm) return;
  const t0 = performance.now();
  if (running) {
    try { mpm.tick(); }
    catch (e) { postMessage({ type:'error', msg: String(e && e.message || e) }); }
  }
  lastTick = performance.now() - t0;

  const buf = buildSnapshot();
  postMessage({ type:'snapshot', count: mpm.nP, buf, tickMs: lastTick }, [buf.buffer]);

  // Aim for ~60 physics ticks/s; yield to the message queue between ticks.
  const delay = Math.max(0, 16 - (performance.now() - t0));
  setTimeout(loop, delay);
}

onmessage = (e) => {
  const d = e.data;
  switch (d.cmd) {
    case 'init':
      mpm = new MPM(d.opts);
      running = true;
      postMessage({ type:'ready' });
      loop();
      break;
    case 'spawnBox':    if (mpm) mpm.spawnBox(...d.args); break;
    case 'reset':       if (mpm) mpm.reset(); break;
    case 'setGravity':  if (mpm) mpm.gravity = d.v; break;
    case 'setSubsteps': if (mpm) mpm.sub = d.v; break;
    case 'pause':       running = false; break;
    case 'resume':      running = true; break;
    case 'returnBuf':   freeBuf = d.buf; break;
  }
};
