/**
 * SimController — abstracts the physics backend.
 *
 * Prefers running the MLS-MPM solver in a Web Worker (off the main thread,
 * so the UI never freezes). If a module worker can't be created it falls
 * back transparently to running the engine on the main thread.
 *
 * The render side only ever reads `controller.count` + `controller.snapshot`
 * (a Float32Array, stride 4: x,y,z,matId), so it doesn't care which
 * backend is active.
 */

import { MPM } from './mpm.js';

export class SimController {
  constructor() {
    this.worker   = null;
    this.mpm      = null;
    this.isWorker = false;
    this.count    = 0;
    this.snapshot = new Float32Array(0);
    this.tickMs   = 0;
    this.opts     = null;
    this._localBuf = null;
  }

  get DOMAIN() { return this.opts.gridN * this.opts.dx; }

  async init(opts) {
    this.opts = opts;
    /* Try a module worker first. */
    try {
      const worker = new Worker(new URL('./mpm-worker.js', import.meta.url), { type:'module' });
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('worker init timeout')), 5000);
        worker.onmessage = (e) => {
          if (e.data && e.data.type === 'ready') { clearTimeout(to); resolve(); }
        };
        worker.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || 'worker error')); };
        worker.postMessage({ cmd:'init', opts });
      });
      /* Steady-state snapshot handler. */
      worker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'snapshot') {
          const oldBuf = this.snapshot.buffer;
          this.snapshot = new Float32Array(d.buf);
          this.count    = d.count;
          this.tickMs   = d.tickMs;
          if (oldBuf.byteLength > 0) {
            try { worker.postMessage({ cmd:'returnBuf', buf: oldBuf }, [oldBuf]); } catch (_) {}
          }
        } else if (d.type === 'error') {
          console.error('Sim worker error:', d.msg);
        }
      };
      worker.onerror = (e) => console.error('Sim worker error:', e.message);
      this.worker = worker;
      this.isWorker = true;
      return 'worker';
    } catch (e) {
      console.warn('Web Worker unavailable — physics will run on the main thread:', e.message);
      this.mpm = new MPM(opts);
      this.isWorker = false;
      return 'main';
    }
  }

  /* ── Commands ──────────────────────────────────────────────── */
  spawnBox(...args) { this.isWorker ? this.worker.postMessage({ cmd:'spawnBox', args }) : this.mpm.spawnBox(...args); }
  reset()           { this.isWorker ? this.worker.postMessage({ cmd:'reset' }) : this.mpm.reset(); }
  setGravity(v)     { this.isWorker ? this.worker.postMessage({ cmd:'setGravity', v }) : (this.mpm.gravity = v); }
  setSubsteps(v)    { this.isWorker ? this.worker.postMessage({ cmd:'setSubsteps', v }) : (this.mpm.sub = v); }

  /* ── Main-thread fallback stepping ─────────────────────────── */
  stepLocal() {
    if (this.isWorker || !this.mpm) return;
    try { this.mpm.tick(); } catch (e) { console.error('MPM tick:', e.message); }
    const n = this.mpm.nP;
    if (!this._localBuf || this._localBuf.length !== n * 4) this._localBuf = new Float32Array(n * 4);
    const b = this._localBuf, m = this.mpm;
    for (let p = 0, o = 0; p < n; p++, o += 4) {
      b[o]=m.px[p]; b[o+1]=m.py[p]; b[o+2]=m.pz[p]; b[o+3]=m.pMt[p];
    }
    this.snapshot = b;
    this.count    = n;
  }
}
