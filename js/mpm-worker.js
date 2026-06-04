/**
 * Physics Web Worker — runs the MLS-MPM solver off the main thread so the
 * UI, camera and rendering stay responsive even at very high particle counts.
 *
 * Protocol (main → worker):
 *   { cmd:'init', opts }            create the engine
 *   { cmd:'spawnBox', args:[...] }  spawn particles
 *   { cmd:'addHeat', x,y,z,r,dT }   inject/remove heat
 *   { cmd:'reset' }                 clear all particles
 *   { cmd:'setGravity', v }
 *   { cmd:'setSubsteps', v }
 *   { cmd:'pause' } / { cmd:'resume' }
 *   { cmd:'returnBuf', buf }        recycle a transferred snapshot buffer
 *
 * Protocol (worker → main):
 *   { type:'ready' }
 *   { type:'snapshot', count, buf, tickMs }   buf = Float32Array stride 5
 *                                              [x,y,z,matId,tempK] per particle
 *   { type:'error', msg }
 */

import { MPM } from './mpm.js';

let mpm = null;
let running = false;
let freeBuf = null;     // recycled ArrayBuffer returned by the main thread
let lastTickMs = 8;

/* Build a compact render snapshot (stride 5: x,y,z,mat,temp). */
function buildSnapshot() {
  const n = mpm.nP;
  const need = n * 5 * 4;
  let f32;
  if (freeBuf && freeBuf.byteLength === need) {
    f32 = new Float32Array(freeBuf);
    freeBuf = null;
  } else {
    f32 = new Float32Array(n * 5);
  }
  const { px, py, pz, pMt, pT } = mpm;
  for (let p = 0, o = 0; p < n; p++, o += 5) {
    f32[o]   = px[p];
    f32[o+1] = py[p];
    f32[o+2] = pz[p];
    f32[o+3] = pMt[p];
    f32[o+4] = pT[p];
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
  lastTickMs = performance.now() - t0;

  const buf = buildSnapshot();
  postMessage({ type:'snapshot', count: mpm.nP, buf, tickMs: lastTickMs }, [buf.buffer]);

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
    case 'spawnBox':   if (mpm) mpm.spawnBox(...d.args); break;
    case 'addHeat':    if (mpm) mpm.addHeat(d.x, d.y, d.z, d.r, d.dT); break;
    case 'reset':      if (mpm) mpm.reset(); break;
    case 'setGravity': if (mpm) mpm.gravity = d.v; break;
    case 'setSubsteps':if (mpm) mpm.sub = d.v; break;
    case 'pause':      running = false; break;
    case 'resume':     running = true; break;
    case 'returnBuf':  freeBuf = d.buf; break;
  }
};
