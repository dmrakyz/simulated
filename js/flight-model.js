/**
 * flight-model.js — full 6-DOF translational + rotational rigid body integrator.
 *
 * Linear dynamics (semi-implicit Euler, all axes):
 *   a = F_aero / m  +  g
 *   v += a·dt  (light residual damping + rate cap)
 *   x += v·dt
 *
 * Rotational dynamics:
 *   α = I⁻¹ · τ_aero   (diagonal inertia, world-frame approx)
 *   ω += α·dt  (rotational damping + cap)
 *   q = normalize(q + 0.5 · q⊗ω̃ · dt)  (quaternion integration)
 *
 * Forward speed (z) is throttle-held; set throttle to drive forward airspeed.
 * `update(dt, force, torque, throttleZ)` is backward-compatible: a scalar
 * force is treated as vertical lift [0, lift, 0]; null torque skips rotation.
 *
 * Pure data — unit-tested under Node.
 */

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export class FlightModel {
  constructor(opts = {}) {
    this.mass    = opts.mass    ?? 4;
    this.g       = opts.g       ?? 9.8;
    this.damp    = opts.damp    ?? 0.3;     // linear velocity residual damp (1/s)
    this.maxRate = opts.maxRate ?? 18;      // m/s linear rate cap
    this.dampRot = opts.dampRot ?? 2.0;    // rotational damping (rad/s per rad/s)
    this.maxOmega = opts.maxOmega ?? 2.5;  // rad/s angular rate cap
    this.enabled = true;
    this.throttle = 0;
    // Diagonal inertia tensor in body/world frame (kg·m²), set by setCreatureExtent.
    this.inertia = [1, 1, 1];
    this._lx = 0; this._ly = 0; this._lz = 0;
    this.reset();
  }

  /**
   * Set the rotational inertia from the creature's AABB (treating it as a
   * uniform rectangular solid). Call after mass changes.
   */
  setCreatureExtent(W, H, L) {
    const m = this.mass;
    this.inertia = [
      m * (H * H + L * L) / 12,
      m * (W * W + L * L) / 12,
      m * (W * W + H * H) / 12,
    ];
  }

  /** Pin the launch position; reset() returns the creature here. */
  setLaunch(x, y, z) {
    this._lx = x; this._ly = y; this._lz = z;
    this.reset();
  }

  reset() {
    this.x = this._lx; this.y = this._ly; this.z = this._lz;
    this.vx = 0; this.vy = 0; this.vz = this.throttle;
    // Orientation as quaternion [x, y, z, w] — identity = no rotation.
    this.q = [0, 0, 0, 1];
    // Angular velocity in world frame (rad/s).
    this.omega = [0, 0, 0];
  }

  weight() { return this.mass * this.g; }

  /** Current world velocity — fed back into the solver as the Galilean inlet. */
  velocity() { return [this.vx, this.vy, this.vz]; }

  /** Current orientation as a Three.js-compatible quaternion [x,y,z,w]. */
  quaternion() { return this.q.slice(); }

  /**
   * Advance by dt seconds.
   *   force     aerodynamic force (N) in world frame. Scalar → [0, lift, 0].
   *   torque    aerodynamic torque (N·m) in world frame. null skips rotation.
   *   throttleZ commanded forward airspeed (m/s). Omit to hold current vz.
   */
  update(dt, force, torque = null, throttleZ = undefined) {
    if (!this.enabled) return this.y;
    const t = Math.min(dt, 0.05);

    // ── Linear ──────────────────────────────────────────────────
    const fx = Array.isArray(force) ? (force[0] || 0) : 0;
    const fy = Array.isArray(force) ? (force[1] || 0) : (force || 0);

    this.vx += (fx / this.mass) * t;
    this.vy += (fy / this.mass - this.g) * t;
    this.vx -= this.damp * this.vx * t;
    this.vy -= this.damp * this.vy * t;
    this.vx = clamp(this.vx, -this.maxRate, this.maxRate);
    this.vy = clamp(this.vy, -this.maxRate, this.maxRate);

    if (throttleZ !== undefined) { this.throttle = throttleZ; this.vz = throttleZ; }

    this.x += this.vx * t;
    this.y += this.vy * t;
    this.z += this.vz * t;

    if (this.y <= this._ly && this.vy < 0) {
      this.y = this._ly; this.vy = 0;
      // Dampen spin on landing.
      this.omega[0] *= 0.5; this.omega[2] *= 0.5;
    }

    // ── Rotational ──────────────────────────────────────────────
    if (torque && Array.isArray(torque)) {
      const [I0, I1, I2] = this.inertia;
      const [tx, ty, tz] = torque;

      this.omega[0] += (tx / (I0 || 1)) * t;
      this.omega[1] += (ty / (I1 || 1)) * t;
      this.omega[2] += (tz / (I2 || 1)) * t;
    }

    // Aerodynamic rotational damping (proportional to ω²: higher at speed).
    const spd = Math.hypot(this.vx, this.vy, this.vz);
    const rotDamp = this.dampRot * (1 + 0.1 * spd);
    for (let a = 0; a < 3; a++) {
      this.omega[a] -= rotDamp * this.omega[a] * t;
      this.omega[a] = clamp(this.omega[a], -this.maxOmega, this.maxOmega);
    }

    // Integrate quaternion: q += 0.5 · q⊗ω̃ · dt, then normalize.
    const [qx, qy, qz, qw] = this.q;
    const [ox, oy, oz] = this.omega;
    // q⊗[ox,oy,oz,0]:
    const dqx = ( qw*ox + qy*oz - qz*oy) * 0.5 * t;
    const dqy = ( qw*oy - qx*oz + qz*ox) * 0.5 * t;
    const dqz = ( qw*oz + qx*oy - qy*ox) * 0.5 * t;
    const dqw = (-qx*ox - qy*oy - qz*oz) * 0.5 * t;
    const nx = qx + dqx, ny = qy + dqy, nz = qz + dqz, nw = qw + dqw;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz + nw*nw) || 1;
    this.q = [nx/len, ny/len, nz/len, nw/len];

    return this.y;
  }

  state() {
    if (this.y <= this._ly + 0.001 && this.vy <= 0) return 'grounded';
    if (this.vy >  0.2) return 'climbing';
    if (this.vy < -0.2) return 'sinking';
    return 'level';
  }
}
