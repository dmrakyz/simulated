/**
 * level.js — one LBM grid level: a D3Q19 single-relaxation-time (BGK) lattice
 * Boltzmann solver in the creature's Galilean frame.
 *
 * This is the CPU reference implementation. It actually runs (and is unit
 * tested under Node), drives the no-WebGPU fallback, and defines the exact
 * numerics the WGSL kernel mirrors on the GPU. Single component (air): the
 * aerodynamic grids only need one medium to produce lift/drag. Dense-fluid
 * multi-material behavior stays in the existing MPM world solver.
 *
 * Scheme: pull streaming with moving (Ladd) bounce-back at solid cells and an
 * equilibrium velocity inlet on the domain faces. In the Galilean frame the
 * creature is stationary and the far field flows past at u_inlet = −v_creature,
 * so a wing at angle of attack develops a pressure difference → net force.
 */

/* ── D3Q19 lattice ─────────────────────────────────────────────────── */
// prettier-ignore
const C = [
  [ 0, 0, 0],
  [ 1, 0, 0], [-1, 0, 0], [ 0, 1, 0], [ 0,-1, 0], [ 0, 0, 1], [ 0, 0,-1],
  [ 1, 1, 0], [-1,-1, 0], [ 1,-1, 0], [-1, 1, 0],
  [ 1, 0, 1], [-1, 0,-1], [ 1, 0,-1], [-1, 0, 1],
  [ 0, 1, 1], [ 0,-1,-1], [ 0, 1,-1], [ 0,-1, 1],
];
// Opposite direction index for each (for bounce-back).
const OPP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17];
// Lattice weights: rest 1/3, 6 faces 1/18, 12 edges 1/36.
const W = [
  1 / 3,
  1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18,
  1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36,
];
const Q = 19;
const CS2 = 1 / 3;        // lattice sound speed squared
const RHO0 = 1.0;         // reference density (lattice units)

export class LbmLevel {
  /**
   * @param dims [nx,ny,nz]
   * @param dx   cell size (m) — kept for coupling/scrolling, numerics are lattice-unit
   * @param opts { tau, label, level }
   */
  constructor(dims, dx, opts = {}) {
    this.dims = dims;
    this.dx = dx;
    this.label = opts.label ?? '';
    this.level = opts.level ?? 0;
    this.tau = opts.tau ?? 0.6;     // relaxation time; ν = c_s²(τ−0.5)
    // Stability ceiling on the local macroscopic speed used for f_eq. LBM goes
    // unstable above ~Ma 0.4 (= 0.4·c_s); clamping here keeps the scheme robust
    // for arbitrarily fast creatures without changing the captured flow shape.
    this.uCap = opts.uCap ?? 0.4 * Math.sqrt(CS2);
    this.n = dims[0] * dims[1] * dims[2];
    this.f = new Float32Array(this.n * Q);
    this.f2 = new Float32Array(this.n * Q);
    this.rho = new Float32Array(this.n);
    this.ux = new Float32Array(this.n);
    this.uy = new Float32Array(this.n);
    this.uz = new Float32Array(this.n);
    // Toroidal world offset (cells), updated as the creature moves.
    this.origin = opts.origin ? opts.origin.slice() : [0, 0, 0];
    this.initEquilibrium(RHO0, [0, 0, 0]);
  }

  idx(i, j, k) { return (i * this.dims[1] + j) * this.dims[2] + k; }

  initEquilibrium(rho, u) {
    const [ux, uy, uz] = u;
    const usqr = 1.5 * (ux * ux + uy * uy + uz * uz);
    for (let c = 0; c < this.n; c++) {
      const b = c * Q;
      for (let q = 0; q < Q; q++) {
        const cu = 3 * (C[q][0] * ux + C[q][1] * uy + C[q][2] * uz);
        this.f[b + q] = W[q] * rho * (1 + cu + 0.5 * cu * cu - usqr);
      }
      this.rho[c] = rho; this.ux[c] = ux; this.uy[c] = uy; this.uz[c] = uz;
    }
  }

  /**
   * Advance one lattice step.
   * @param inletVel [ux,uy,uz] far-field flow in lattice units (= −v_creature·Δt/Δx)
   * @param mask     optional { solid, wallVel } from solid-mask.js
   */
  step(inletVel = [0, 0, 0], mask = null) {
    const { dims, f, f2, tau } = this;
    const [nx, ny, nz] = dims;
    const omega = 1 / tau;
    const solid = mask?.solid;
    const wallVel = mask?.wallVel;

    // 1 — Collision (BGK) in place on f, computing macroscopics.
    for (let c = 0; c < this.n; c++) {
      if (solid && solid[c]) continue;
      const b = c * Q;
      let rho = 0, mx = 0, my = 0, mz = 0;
      for (let q = 0; q < Q; q++) {
        const fq = f[b + q];
        rho += fq;
        mx += fq * C[q][0]; my += fq * C[q][1]; mz += fq * C[q][2];
      }
      const inv = rho > 1e-9 ? 1 / rho : 0;
      let ux = mx * inv, uy = my * inv, uz = mz * inv;
      // Clamp local speed to the stability ceiling before relaxing toward f_eq.
      const umag = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (umag > this.uCap) { const s = this.uCap / umag; ux *= s; uy *= s; uz *= s; }
      this.rho[c] = rho; this.ux[c] = ux; this.uy[c] = uy; this.uz[c] = uz;
      const usqr = 1.5 * (ux * ux + uy * uy + uz * uz);
      for (let q = 0; q < Q; q++) {
        const cu = 3 * (C[q][0] * ux + C[q][1] * uy + C[q][2] * uz);
        const feq = W[q] * rho * (1 + cu + 0.5 * cu * cu - usqr);
        f[b + q] += omega * (feq - f[b + q]);
      }
    }

    // 2 — Streaming (pull) with bounce-back at solids and inlet on faces.
    const iusqr = 1.5 * (inletVel[0] ** 2 + inletVel[1] ** 2 + inletVel[2] ** 2);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nz; k++) {
          const c = this.idx(i, j, k);
          const b = c * Q;
          if (solid && solid[c]) { for (let q = 0; q < Q; q++) f2[b + q] = f[b + q]; continue; }
          for (let q = 0; q < Q; q++) {
            // Pull from upstream neighbor x − c_q.
            const si = i - C[q][0], sj = j - C[q][1], sk = k - C[q][2];
            if (si < 0 || si >= nx || sj < 0 || sj >= ny || sk < 0 || sk >= nz) {
              // Domain face → equilibrium inlet at far-field velocity.
              const cu = 3 * (C[q][0] * inletVel[0] + C[q][1] * inletVel[1] + C[q][2] * inletVel[2]);
              f2[b + q] = W[q] * RHO0 * (1 + cu + 0.5 * cu * cu - iusqr);
              continue;
            }
            const sc = this.idx(si, sj, sk);
            if (solid && solid[sc]) {
              // Moving bounce-back (Ladd): the population that would have come
              // from the solid is replaced by this cell's own opposite
              // population, plus a momentum term from the wall's velocity.
              const op = OPP[q];
              const uw = wallVel
                ? (C[q][0] * wallVel[sc * 3] + C[q][1] * wallVel[sc * 3 + 1] + C[q][2] * wallVel[sc * 3 + 2])
                : 0;
              f2[b + q] = f[c * Q + op] + 6 * W[q] * RHO0 * uw;
            } else {
              f2[b + q] = f[sc * Q + q];
            }
          }
        }
      }
    }

    // Swap buffers.
    const tmp = this.f; this.f = this.f2; this.f2 = tmp;
  }

  /**
   * Aerodynamic perturbation force — the correct measurement for lift/drag.
   *
   * Total fluid momentum contains the background flow (every cell moving at
   * u_inlet), which completely dominates and makes the number meaningless (that
   * was the "985 N" bug). Subtracting the background leaves only the momentum
   * perturbation caused by the creature's pressure field.
   *
   * @param inletVel lattice-unit inlet velocity (from toLatticeVel in multi-level)
   */
  aerodynamicForce(inletVel = [0, 0, 0]) {
    let totalRho = 0, dmx = 0, dmy = 0, dmz = 0;
    for (let c = 0; c < this.n; c++) {
      const r = this.rho[c];
      totalRho += r;
      dmx += r * (this.ux[c] - inletVel[0]);
      dmy += r * (this.uy[c] - inletVel[1]);
      dmz += r * (this.uz[c] - inletVel[2]);
    }
    return [dmx, dmy, dmz];
  }

  totalMass() {
    let m = 0;
    for (let c = 0; c < this.n; c++) m += this.rho[c];
    return m;
  }

  /** Raw total momentum — kept for tests; use aerodynamicForce() for display. */
  fluidMomentum() {
    let mx = 0, my = 0, mz = 0;
    for (let c = 0; c < this.n; c++) { mx += this.rho[c] * this.ux[c]; my += this.rho[c] * this.uy[c]; mz += this.rho[c] * this.uz[c]; }
    return [mx, my, mz];
  }
}

export { C as D3Q19_C, W as D3Q19_W, OPP as D3Q19_OPP };
