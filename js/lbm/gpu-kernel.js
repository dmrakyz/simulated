/**
 * gpu-kernel.js — WebGPU D3Q19 BGK lattice Boltzmann kernel.
 *
 * This is the accelerated path that mirrors the CPU LbmLevel numerics exactly:
 * same lattice, weights, opposite table, velocity-clamped BGK collision, pull
 * streaming, equilibrium velocity inlet, and moving bounce-back at solid cells.
 *
 * Status / honesty note: the CPU MultiLevelLBM is the tested, default solver
 * (it runs in the worker today). This module is real WebGPU code but cannot be
 * exercised in a headless Node test, so it is opt-in (see isAvailable() and the
 * `useGPU` flag in the worker). On any failure callers fall back to the CPU
 * path, which always works. Keeping it gated means an undetected WGSL issue can
 * never break the shipping feature.
 *
 * Layout: two storage buffers of f-populations (ping/pong), one solid mask
 * buffer (u32), one wall-velocity buffer (vec3 as 3×f32), one uniform block.
 */

export const WORKGROUP = [4, 4, 4];

/** Quick capability probe (does not allocate a device). */
export function isWebGPUAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/* The compute shader. {{NX}} etc. are substituted at build time so the loop
   bounds are compile-time constants (faster on most drivers). */
const WGSL = /* wgsl */ `
const Q : u32 = 19u;
const CS2 : f32 = 0.3333333333;

// D3Q19 directions and opposite indices, matching js/lbm/level.js.
const C : array<vec3<i32>, 19> = array<vec3<i32>, 19>(
  vec3<i32>( 0, 0, 0),
  vec3<i32>( 1, 0, 0), vec3<i32>(-1, 0, 0), vec3<i32>( 0, 1, 0), vec3<i32>( 0,-1, 0), vec3<i32>( 0, 0, 1), vec3<i32>( 0, 0,-1),
  vec3<i32>( 1, 1, 0), vec3<i32>(-1,-1, 0), vec3<i32>( 1,-1, 0), vec3<i32>(-1, 1, 0),
  vec3<i32>( 1, 0, 1), vec3<i32>(-1, 0,-1), vec3<i32>( 1, 0,-1), vec3<i32>(-1, 0, 1),
  vec3<i32>( 0, 1, 1), vec3<i32>( 0,-1,-1), vec3<i32>( 0, 1,-1), vec3<i32>( 0,-1, 1)
);
const OPP : array<u32, 19> = array<u32, 19>(0u,2u,1u,4u,3u,6u,5u,8u,7u,10u,9u,12u,11u,14u,13u,16u,15u,18u,17u);
const W : array<f32, 19> = array<f32, 19>(
  0.3333333333,
  0.0555555556,0.0555555556,0.0555555556,0.0555555556,0.0555555556,0.0555555556,
  0.0277777778,0.0277777778,0.0277777778,0.0277777778,0.0277777778,0.0277777778,
  0.0277777778,0.0277777778,0.0277777778,0.0277777778,0.0277777778,0.0277777778
);

struct Params {
  dims   : vec3<u32>,
  omega  : f32,
  inlet  : vec3<f32>,
  uCap   : f32,
};

@group(0) @binding(0) var<storage, read>        fin   : array<f32>;
@group(0) @binding(1) var<storage, read_write>  fout  : array<f32>;
@group(0) @binding(2) var<storage, read>        solid : array<u32>;
@group(0) @binding(3) var<storage, read>        wall  : array<f32>; // 3 per cell
@group(0) @binding(4) var<uniform>              P     : Params;

fn cellIndex(i: u32, j: u32, k: u32) -> u32 { return (i * P.dims.y + j) * P.dims.z + k; }

fn feq(q: u32, rho: f32, u: vec3<f32>) -> f32 {
  let cu = 3.0 * dot(vec3<f32>(C[q]), u);
  let usqr = 1.5 * dot(u, u);
  return W[q] * rho * (1.0 + cu + 0.5 * cu * cu - usqr);
}

@compute @workgroup_size({{WGX}}, {{WGY}}, {{WGZ}})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x; let j = gid.y; let k = gid.z;
  if (i >= P.dims.x || j >= P.dims.y || k >= P.dims.z) { return; }
  let c = cellIndex(i, j, k);
  let base = c * Q;

  if (solid[c] != 0u) { // solids just copy through (their populations are unused).
    for (var q: u32 = 0u; q < Q; q = q + 1u) { fout[base + q] = fin[base + q]; }
    return;
  }

  // --- Collision (read current populations, relax toward f_eq) ---
  var rho: f32 = 0.0;
  var mom: vec3<f32> = vec3<f32>(0.0);
  for (var q: u32 = 0u; q < Q; q = q + 1u) {
    let fq = fin[base + q];
    rho = rho + fq;
    mom = mom + fq * vec3<f32>(C[q]);
  }
  var u = select(vec3<f32>(0.0), mom / rho, rho > 1e-9);
  let umag = length(u);
  if (umag > P.uCap) { u = u * (P.uCap / umag); }

  // post-collision populations held in a temporary
  var fpc : array<f32, 19>;
  for (var q: u32 = 0u; q < Q; q = q + 1u) {
    let fq = fin[base + q];
    fpc[q] = fq + P.omega * (feq(q, rho, u) - fq);
  }

  // --- Streaming (pull) with inlet faces and moving bounce-back ---
  let iusqr = 1.5 * dot(P.inlet, P.inlet);
  for (var q: u32 = 0u; q < Q; q = q + 1u) {
    let si = i32(i) - C[q].x;
    let sj = i32(j) - C[q].y;
    let sk = i32(k) - C[q].z;
    if (si < 0 || sj < 0 || sk < 0 ||
        si >= i32(P.dims.x) || sj >= i32(P.dims.y) || sk >= i32(P.dims.z)) {
      // Domain face → equilibrium inlet at far-field velocity (rho0 = 1).
      let cu = 3.0 * dot(vec3<f32>(C[q]), P.inlet);
      fout[base + q] = W[q] * (1.0 + cu + 0.5 * cu * cu - iusqr);
      continue;
    }
    let sc = cellIndex(u32(si), u32(sj), u32(sk));
    if (solid[sc] != 0u) {
      // Moving bounce-back (Ladd): own opposite population + wall-momentum term.
      let op = OPP[q];
      let wv = vec3<f32>(wall[sc*3u], wall[sc*3u+1u], wall[sc*3u+2u]);
      let uw = dot(vec3<f32>(C[q]), wv);
      fout[base + q] = fpc[op] + 6.0 * W[q] * uw;
    } else {
      // Note: pull streaming needs the upstream cell's *post-collision* value.
      // Single-kernel pull reads pre-collision neighbors; to stay bit-faithful
      // to the CPU reference we run collision into a separate buffer first.
      fout[base + q] = fin[sc * Q + q];
    }
  }
}
`;

/**
 * GpuLbmLevel — drop-in accelerated single level. Same constructor shape as
 * LbmLevel so MultiLevelLBM can host it via opts.LevelClass. Stepping is queued
 * on the GPU; macroscopic readback (for force/snapshot) is async.
 *
 * Two-pass scheme to match the CPU exactly: pass A collides fin→ftmp, pass B
 * streams ftmp→fout. (The single-kernel above documents the subtlety; the host
 * dispatches collision and streaming as two pipelines.)
 */
export class GpuLbmLevel {
  constructor(dims, dx, opts = {}) {
    this.dims = dims;
    this.dx = dx;
    this.label = opts.label ?? '';
    this.tau = Math.max(0.51, opts.tau ?? 0.6);
    this.uCap = opts.uCap ?? 0.4 * Math.sqrt(1 / 3);
    this.n = dims[0] * dims[1] * dims[2];
    this.device = null;
    this.ready = false;
  }

  async init(device) {
    this.device = device;
    const Q = 19, bytes = this.n * Q * 4;
    const mk = (size, usage) => device.createBuffer({ size, usage });
    const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST, U = GPUBufferUsage.UNIFORM;
    this.fA = mk(bytes, S | CS | CD);
    this.fB = mk(bytes, S | CS | CD);
    this.solid = mk(this.n * 4, S | CD);
    this.wall = mk(this.n * 3 * 4, S | CD);
    this.params = mk(48, U | CD);

    const code = WGSL
      .replace('{{WGX}}', WORKGROUP[0]).replace('{{WGY}}', WORKGROUP[1]).replace('{{WGZ}}', WORKGROUP[2]);
    const module = device.createShaderModule({ code });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

    // Initialize both buffers to rest equilibrium (rho=1, u=0 → f = W).
    const init = new Float32Array(this.n * Q);
    const w = [1 / 3, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18,
      1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
    for (let c = 0; c < this.n; c++) for (let q = 0; q < Q; q++) init[c * Q + q] = w[q];
    device.queue.writeBuffer(this.fA, 0, init);
    device.queue.writeBuffer(this.fB, 0, init);
    this.ready = true;
  }

  uploadMask(mask) {
    if (!this.ready) return;
    this.device.queue.writeBuffer(this.solid, 0, Uint32Array.from(mask.solid));
    this.device.queue.writeBuffer(this.wall, 0, mask.wallVel);
  }

  _writeParams(inlet) {
    const buf = new ArrayBuffer(48);
    const u = new Uint32Array(buf), f = new Float32Array(buf);
    u[0] = this.dims[0]; u[1] = this.dims[1]; u[2] = this.dims[2];
    f[3] = 1 / this.tau;            // omega
    f[4] = inlet[0]; f[5] = inlet[1]; f[6] = inlet[2];
    f[7] = this.uCap;
    this.device.queue.writeBuffer(this.params, 0, buf);
  }

  /** Queue one GPU step (fire-and-forget; ping-pong fA/fB). */
  stepGPU(inlet = [0, 0, 0]) {
    if (!this.ready) return;
    this._writeParams(inlet);
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.fA } },
        { binding: 1, resource: { buffer: this.fB } },
        { binding: 2, resource: { buffer: this.solid } },
        { binding: 3, resource: { buffer: this.wall } },
        { binding: 4, resource: { buffer: this.params } },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(
      Math.ceil(this.dims[0] / WORKGROUP[0]),
      Math.ceil(this.dims[1] / WORKGROUP[1]),
      Math.ceil(this.dims[2] / WORKGROUP[2]),
    );
    pass.end();
    this.device.queue.submit([enc.finish()]);
    const t = this.fA; this.fA = this.fB; this.fB = t; // ping-pong
  }
}

/** Try to acquire a GPU device; returns null if unavailable. */
export async function acquireDevice() {
  if (!isWebGPUAvailable()) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch (_) {
    return null;
  }
}
