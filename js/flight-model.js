/**
 * flight-model.js — 6-DOF rigid body integrator.
 *
 * Linear dynamics (semi-implicit Euler, all axes):
 *   a = F_aero / m  +  g
 *   v += a·dt  (tiny residual damp + rate cap)
 *   x += v·dt
 *
 * Rotational dynamics:
 *   α = I⁻¹ · τ   (diagonal inertia, world-frame approx)
 *   ω += α·dt     (speed-dependent aero damp + cap)
 *   q = normalize(q + 0.5 · q⊗ω̃ · dt)
 *
 * The creature starts at rest. External wind (worldWind in the LBM inlet) or
 * the creature's own falling velocity drives aerodynamic forces. No thrust.
 *
 * `update(dt, force, torque)` — all world-frame (N, N·m).
 * Scalar force treated as vertical lift [0, lift, 0] for backward compat.
 *
 * Pure data — unit-tested under Node.
 */

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export class FlightModel {
  constructor(opts = {}) {
    this.mass     = opts.mass     ?? 4;
    this.g        = opts.g        ?? 9.8;
    // Linear aerodynamic damping (≈ -c·v drag), applied every frame from the
    // CURRENT velocity — i.e. with zero lag. The LBM force, by contrast, is
    // smoothed and worker-throttled (~15 Hz vs. 60 Hz render): it reacts to
    // where the creature WAS, not where it is. Feeding a stale, amplified
    // correction back into a falling body is a textbook delayed-feedback
    // oscillator — "fall a bit → big lagged shove the other way → overshoot
    // → bigger lagged shove back" → it never settles (a "stray leaf"). This
    // term is the instantaneous counter-force that breaks that loop: it pulls
    // toward a stable terminal velocity on its own, so the LBM force only has
    // to add lift/maneuvering detail on top of an already-stable glide.
    this.damp     = opts.damp     ?? 1.0;
    this.maxRate  = opts.maxRate  ?? 18;
    // Rotational damp is intentionally high: LBM torque is noisy, so we rely
    // on heavy damping to absorb noise and let only sustained torques rotate.
    this.dampRot  = opts.dampRot  ?? 6.0;
    this.maxOmega = opts.maxOmega ?? 0.8;
    this.enabled  = true;
    this.inertia  = [1, 1, 1];
    this._lx = 0; this._ly = 0; this._lz = 0;
    this.reset();
  }

  setCreatureExtent(W, H, L) {
    const m = this.mass;
    this.inertia = [
      m * (H * H + L * L) / 12,
      m * (W * W + L * L) / 12,
      m * (W * W + H * H) / 12,
    ];
  }

  setLaunch(x, y, z) { this._lx = x; this._ly = y; this._lz = z; this.reset(); }

  reset() {
    this.x = this._lx; this.y = this._ly; this.z = this._lz;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.q = [0, 0, 0, 1];
    this.omega = [0, 0, 0];
  }

  weight() { return this.mass * this.g; }

  /** World velocity — fed back to the LBM as the Galilean inlet component. */
  velocity() { return [this.vx, this.vy, this.vz]; }

  /** Orientation as a Three.js-compatible quaternion [x,y,z,w]. */
  quaternion() { return this.q.slice(); }

  /**
   * Advance by dt seconds.
   * @param {number}  dt
   * @param {number|number[]} force  Aero force (N), world frame. Scalar → [0,F,0].
   * @param {number[]|null}   torque Aero+stabilizer torque (N·m), world frame.
   */
  update(dt, force, torque = null) {
    if (!this.enabled) return this.y;
    const t = Math.min(dt, 0.05);

    const m  = this.mass;
    const fx = Array.isArray(force) ? (force[0] || 0) : 0;
    const fy = Array.isArray(force) ? (force[1] || 0) : (force || 0);
    const fz = Array.isArray(force) ? (force[2] || 0) : 0;

    this.vx += (fx / m) * t;
    this.vy += (fy / m - this.g) * t;
    this.vz += (fz / m) * t;
    this.vx -= this.damp * this.vx * t;
    this.vy -= this.damp * this.vy * t;
    this.vz -= this.damp * this.vz * t;
    this.vx = clamp(this.vx, -this.maxRate, this.maxRate);
    this.vy = clamp(this.vy, -this.maxRate, this.maxRate);
    this.vz = clamp(this.vz, -this.maxRate, this.maxRate);

    this.x += this.vx * t;
    this.y += this.vy * t;
    this.z += this.vz * t;

    // Ground clamp at launch Y (set to creature's lowest-point clearance).
    if (this.y <= this._ly && this.vy < 0) {
      this.y  = this._ly;
      this.vy = 0;
      // Kill most horizontal spin on landing.
      this.vx *= 0.3; this.vz *= 0.3;
      this.omega[0] *= 0.3; this.omega[2] *= 0.3;
    }

    // ── Rotation ────────────────────────────────────────────────
    if (torque && Array.isArray(torque)) {
      const [I0, I1, I2] = this.inertia;
      this.omega[0] += (torque[0] / (I0 || 1)) * t;
      this.omega[1] += (torque[1] / (I1 || 1)) * t;
      this.omega[2] += (torque[2] / (I2 || 1)) * t;
    }
    const spd = Math.hypot(this.vx, this.vy, this.vz);
    const rd = this.dampRot * (1 + 0.08 * spd);
    for (let a = 0; a < 3; a++) {
      this.omega[a] -= rd * this.omega[a] * t;
      this.omega[a] = clamp(this.omega[a], -this.maxOmega, this.maxOmega);
    }

    const [qx, qy, qz, qw] = this.q;
    const [ox, oy, oz] = this.omega;
    const dqx = ( qw*ox + qy*oz - qz*oy) * 0.5 * t;
    const dqy = ( qw*oy - qx*oz + qz*ox) * 0.5 * t;
    const dqz = ( qw*oz + qx*oy - qy*ox) * 0.5 * t;
    const dqw = (-qx*ox - qy*oy - qz*oz) * 0.5 * t;
    const nx = qx+dqx, ny = qy+dqy, nz = qz+dqz, nw = qw+dqw;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz + nw*nw) || 1;
    this.q = [nx/len, ny/len, nz/len, nw/len];

    return this.y;
  }

  state() {
    if (this.y <= this._ly + 0.01 && this.vy <= 0) return 'grounded';
    if (this.vy >  0.2) return 'climbing';
    if (this.vy < -0.2) return 'sinking';
    return 'level';
  }
}
