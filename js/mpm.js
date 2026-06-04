/**
 * MLS-MPM Physics Engine (Moving Least Squares Material Point Method)
 * Hu et al. 2018 — CPU implementation, fully self-contained, no external deps.
 *
 * Supports: fluid (weakly compressible EOS), granular (Drucker-Prager approx.),
 *           elastic (neo-Hookean approx.), snow (capped elastic).
 */

export const MATERIALS = [
  // id 0: Water
  { name:'Water',  col:0x2288ff, rho:1000, k:150,  damp:0.9985, type:'fluid' },
  // id 1: Sand
  { name:'Sand',   col:0xddbb55, rho:1650, k:20,   damp:0.960, type:'granular' },
  // id 2: Lava
  { name:'Lava',   col:0xff5500, rho:2700, k:800,  damp:0.980, type:'fluid' },
  // id 3: Snow
  { name:'Snow',   col:0xddeeff, rho:400,  k:150,  damp:0.990, type:'snow' },
  // id 4: Honey
  { name:'Honey',  col:0xffbb22, rho:1400, k:400,  damp:0.940, type:'fluid' },
  // id 5: Mud
  { name:'Mud',    col:0x7a5c3a, rho:1900, k:80,   damp:0.920, type:'granular' },
  // id 6: Oil
  { name:'Oil',    col:0x334422, rho:850,  k:350,  damp:0.992, type:'fluid' },
  // id 7: Ice
  { name:'Ice',    col:0xaaddff, rho:917,  k:2000, damp:0.998, type:'elastic' },
];

export class MPM {
  /**
   * @param {object} opts
   * @param {number} opts.gridN       cells per axis (default 48)
   * @param {number} opts.dx          cell size in metres (default 0.25)
   * @param {number} opts.maxParticles
   * @param {number} opts.substeps    physics substeps per tick
   */
  constructor(opts = {}) {
    this.N    = opts.gridN        || 48;
    this.DX   = opts.dx           || 0.25;
    this.MAX  = opts.maxParticles || 16000;
    this.sub  = opts.substeps     || 6;
    this.gravity = opts.gravity   ?? -9.8;

    this.INV  = 1 / this.DX;
    this.N2   = this.N * this.N;
    this.N3   = this.N * this.N * this.N;
    this.DOMAIN = this.N * this.DX;

    /* particle buffers */
    const M = this.MAX;
    this.px  = new Float32Array(M);
    this.py  = new Float32Array(M);
    this.pz  = new Float32Array(M);
    this.pvx = new Float32Array(M);
    this.pvy = new Float32Array(M);
    this.pvz = new Float32Array(M);
    this.pC  = new Float32Array(M * 9); // APIC affine matrix 3×3
    this.pJ  = new Float32Array(M).fill(1.0);
    this.pMt = new Uint8Array(M);
    this.nP  = 0;

    /* grid buffers */
    this.gM  = new Float32Array(this.N3);
    this.gVx = new Float32Array(this.N3);
    this.gVy = new Float32Array(this.N3);
    this.gVz = new Float32Array(this.N3);

    /* reusable weight arrays to avoid per-iteration GC */
    this._WX = new Float32Array(3);
    this._WY = new Float32Array(3);
    this._WZ = new Float32Array(3);
  }

  /* ── Spawn helpers ──────────────────────────────────────── */

  /**
   * Spawn a filled axis-aligned box of particles.
   * ppc = particles per cell per axis (2 → step = DX/2)
   */
  spawnBox(x0, y0, z0, x1, y1, z1, matId, ppc = 2) {
    const step = this.DX / ppc;
    const lo   = 1.5 * this.DX;
    const hi   = (this.N - 1.5) * this.DX;
    const jitter = step * 0.3;

    for (let x = x0; x < x1; x += step) {
      for (let y = y0; y < y1; y += step) {
        for (let z = z0; z < z1; z += step) {
          if (this.nP >= this.MAX) return;
          const i = this.nP;
          this.px[i]  = Math.max(lo, Math.min(hi, x + (Math.random() - 0.5) * jitter));
          this.py[i]  = Math.max(lo, Math.min(hi, y + (Math.random() - 0.5) * jitter));
          this.pz[i]  = Math.max(lo, Math.min(hi, z + (Math.random() - 0.5) * jitter));
          this.pvx[i] = 0; this.pvy[i] = 0; this.pvz[i] = 0;
          this.pJ[i]  = 1.0;
          this.pMt[i] = matId;
          const Co = i * 9;
          for (let ci = 0; ci < 9; ci++) this.pC[Co + ci] = 0;
          this.nP++;
        }
      }
    }
  }

  /** Remove all particles */
  reset() { this.nP = 0; }

  /* ── Physics tick ──────────────────────────────────────── */

  /**
   * Advance simulation by one wall-clock frame.
   * Internally runs this.sub substeps.
   */
  tick() {
    const DT = 1 / 60 / this.sub;
    for (let s = 0; s < this.sub; s++) {
      this._step(DT);
    }
  }

  _step(DT) {
    const { N, INV, DX, MAX, N3,
            px, py, pz, pvx, pvy, pvz, pC, pJ, pMt, nP,
            gM, gVx, gVy, gVz, _WX, _WY, _WZ } = this;

    /* ── RESET GRID ────────────────────────────────────────── */
    gM.fill(0); gVx.fill(0); gVy.fill(0); gVz.fill(0);

    /* ── P2G (particle → grid) ─────────────────────────────── */
    for (let p = 0; p < nP; p++) {
      const mt  = pMt[p];
      const mat = MATERIALS[mt];
      const J   = pJ[p];

      /*
       * Isotropic Kirchhoff stress scale for this particle.
       * Fluids/granular: one-sided (compression only) — no tensile restoring
       * force that would cause spurious "breathing" oscillations.
       * Elastic/snow: two-sided so the material resists both stretch and compression.
       */
      const jDev = (mat.type === 'fluid' || mat.type === 'granular')
        ? Math.min(0.0, J - 1.0)
        : (J - 1.0);
      const ss = -DT * (1.0 / mat.rho) * 4.0 * INV * INV * mat.k * jDev;

      const xp = px[p], yp = py[p], zp = pz[p];

      /* base grid cell (quadratic B-spline stencil) */
      const bx = (xp * INV - 0.5) | 0;
      const by = (yp * INV - 0.5) | 0;
      const bz = (zp * INV - 0.5) | 0;
      const fx  = xp * INV - bx;   // fractional offset ∈ [0.5, 1.5)
      const fy  = yp * INV - by;
      const fz  = zp * INV - bz;

      /* quadratic B-spline weights */
      _WX[0] = 0.5*(1.5-fx)*(1.5-fx); _WX[1] = 0.75-(fx-1)*(fx-1); _WX[2] = 0.5*(fx-0.5)*(fx-0.5);
      _WY[0] = 0.5*(1.5-fy)*(1.5-fy); _WY[1] = 0.75-(fy-1)*(fy-1); _WY[2] = 0.5*(fy-0.5)*(fy-0.5);
      _WZ[0] = 0.5*(1.5-fz)*(1.5-fz); _WZ[1] = 0.75-(fz-1)*(fz-1); _WZ[2] = 0.5*(fz-0.5)*(fz-0.5);

      const Co = p * 9;
      const vx = pvx[p], vy = pvy[p], vz = pvz[p];
      const C0=pC[Co],   C1=pC[Co+1], C2=pC[Co+2];
      const C3=pC[Co+3], C4=pC[Co+4], C5=pC[Co+5];
      const C6=pC[Co+6], C7=pC[Co+7], C8=pC[Co+8];

      for (let i = 0; i < 3; i++) {
        const gi = bx + i; if (gi < 0 || gi >= N) continue;
        const dpx = (i - fx) * DX;
        for (let j = 0; j < 3; j++) {
          const gj = by + j; if (gj < 0 || gj >= N) continue;
          const dpy = (j - fy) * DX;
          const wij = _WX[i] * _WY[j];
          for (let k = 0; k < 3; k++) {
            const gk = bz + k; if (gk < 0 || gk >= N) continue;
            const dpz = (k - fz) * DX;
            const w   = wij * _WZ[k];
            const idx = (gi * N + gj) * N + gk;

            gM[idx]  += w;
            /* momentum = mass*(v + C*dpos) + stress_force = w*(v + C*dpos + ss*dpos) */
            gVx[idx] += w * (vx + C0*dpx + C1*dpy + C2*dpz + ss*dpx);
            gVy[idx] += w * (vy + C3*dpx + C4*dpy + C5*dpz + ss*dpy);
            gVz[idx] += w * (vz + C6*dpx + C7*dpy + C8*dpz + ss*dpz);
          }
        }
      }
    }

    /* ── GRID UPDATE ───────────────────────────────────────── */
    const g = this.gravity;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        for (let k = 0; k < N; k++) {
          const idx  = (i * N + j) * N + k;
          const mass = gM[idx];
          if (mass < 1e-9) continue;

          const im  = 1.0 / mass;
          let vx = gVx[idx] * im;
          let vy = gVy[idx] * im + DT * g;
          let vz = gVz[idx] * im;

          /* hard boundary (reflect normal component) */
          if (i < 2   && vx < 0) vx = 0.0;
          if (i > N-3 && vx > 0) vx = 0.0;
          if (j < 2   && vy < 0) vy = 0.0;
          if (j > N-3 && vy > 0) vy = 0.0;
          if (k < 2   && vz < 0) vz = 0.0;
          if (k > N-3 && vz > 0) vz = 0.0;

          gVx[idx] = vx;
          gVy[idx] = vy;
          gVz[idx] = vz;
        }
      }
    }

    /* ── G2P (grid → particle) + advect ───────────────────── */
    const SC = 4.0 * INV * INV;
    const lo = 1.5 * DX;
    const hi = (N - 1.5) * DX;

    for (let p = 0; p < nP; p++) {
      const xp = px[p], yp = py[p], zp = pz[p];
      const bx = (xp * INV - 0.5) | 0;
      const by = (yp * INV - 0.5) | 0;
      const bz = (zp * INV - 0.5) | 0;
      const fx  = xp * INV - bx;
      const fy  = yp * INV - by;
      const fz  = zp * INV - bz;

      _WX[0] = 0.5*(1.5-fx)*(1.5-fx); _WX[1] = 0.75-(fx-1)*(fx-1); _WX[2] = 0.5*(fx-0.5)*(fx-0.5);
      _WY[0] = 0.5*(1.5-fy)*(1.5-fy); _WY[1] = 0.75-(fy-1)*(fy-1); _WY[2] = 0.5*(fy-0.5)*(fy-0.5);
      _WZ[0] = 0.5*(1.5-fz)*(1.5-fz); _WZ[1] = 0.75-(fz-1)*(fz-1); _WZ[2] = 0.5*(fz-0.5)*(fz-0.5);

      let nvx=0, nvy=0, nvz=0;
      let C0=0, C1=0, C2=0, C3=0, C4=0, C5=0, C6=0, C7=0, C8=0;

      for (let i = 0; i < 3; i++) {
        const gi = bx + i; if (gi < 0 || gi >= N) continue;
        const dpx = (i - fx) * DX;
        for (let j = 0; j < 3; j++) {
          const gj = by + j; if (gj < 0 || gj >= N) continue;
          const dpy = (j - fy) * DX;
          const wij = _WX[i] * _WY[j];
          for (let k = 0; k < 3; k++) {
            const gk = bz + k; if (gk < 0 || gk >= N) continue;
            const dpz = (k - fz) * DX;
            const w   = wij * _WZ[k];
            const idx = (gi * N + gj) * N + gk;
            const gvx = gVx[idx], gvy = gVy[idx], gvz = gVz[idx];

            nvx += w * gvx; nvy += w * gvy; nvz += w * gvz;

            /* APIC: C += (4/dx²) * w * v_grid ⊗ dpos */
            const sc = w * SC;
            C0 += sc*gvx*dpx; C1 += sc*gvx*dpy; C2 += sc*gvx*dpz;
            C3 += sc*gvy*dpx; C4 += sc*gvy*dpy; C5 += sc*gvy*dpz;
            C6 += sc*gvz*dpx; C7 += sc*gvz*dpy; C8 += sc*gvz*dpz;
          }
        }
      }

      /* viscosity / friction damping (per material) */
      const d = MATERIALS[pMt[p]].damp;
      pvx[p] = nvx * d;
      pvy[p] = nvy * d;
      pvz[p] = nvz * d;

      /* write APIC matrix */
      const Co = p * 9;
      pC[Co]=C0; pC[Co+1]=C1; pC[Co+2]=C2;
      pC[Co+3]=C3; pC[Co+4]=C4; pC[Co+5]=C5;
      pC[Co+6]=C6; pC[Co+7]=C7; pC[Co+8]=C8;

      /* J update via velocity divergence: J *= (1 + dt*trace(C)) */
      let newJ = pJ[p] * (1.0 + DT * (C0 + C4 + C8));

      /* Granular: prevent tension (J can't exceed 1 much, clamp expansion) */
      if (MATERIALS[pMt[p]].type === 'granular') {
        newJ = Math.min(newJ, 1.0);
      }
      pJ[p] = Math.max(0.5, Math.min(3.0, newJ));

      /* advect */
      let npx = xp + DT * nvx;
      let npy = yp + DT * nvy;
      let npz = zp + DT * nvz;

      /* clamp to domain */
      px[p] = npx < lo ? lo : npx > hi ? hi : npx;
      py[p] = npy < lo ? lo : npy > hi ? hi : npy;
      pz[p] = npz < lo ? lo : npz > hi ? hi : npz;
    }
  }
}
