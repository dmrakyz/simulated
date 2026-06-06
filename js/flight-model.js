/**
 * flight-model.js — full 3-axis rigid-body translational flight integrator.
 *
 * This is a *closed-loop* model: it integrates the creature's velocity from the
 * measured aerodynamic force (from the LBM) plus gravity, then the caller feeds
 * that velocity back into the solver as the Galilean far-field. So if the
 * creature stalls and drops, its downward velocity becomes upward relative
 * wind, the body/wings feel that wind, and the resulting drag opposes the fall —
 * terminal velocity, ballistic arcs, and recovery all emerge from the physics
 * rather than from a scripted rule. "It feels the wind of its own falling."
 *
 * Dynamics (semi-implicit Euler), per axis:
 *   a = F_aero / m  +  g            (g = (0, −9.8, 0))
 *   v += a·dt   (then a light residual damp + a rate cap for numerical safety)
 *   x += v·dt
 *
 * Forward speed is throttle-driven (the creature's flapping holds airspeed), so
 * the z-axis tracks the throttle while x and y are fully force-integrated. Pass
 * the throttle as the 3rd arg; omit it and z holds. Ground contact clamps y at
 * the launch height. Pure data — unit-tested under Node.
 */

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export class FlightModel {
  constructor(opts = {}) {
    this.mass    = opts.mass    ?? 4;     // kg
    this.g       = opts.g       ?? 9.8;   // m/s²
    this.damp    = opts.damp    ?? 0.3;   // residual 1/s damping (aero drag does most)
    this.maxRate = opts.maxRate ?? 18;    // m/s per-axis velocity cap (stability)
    this.enabled = true;
    this.throttle = 0;                    // commanded forward airspeed (m/s, +z)
    this._lx = 0; this._ly = 0; this._lz = 0;
    this.reset();
  }

  /** Pin the launch position; reset() returns the creature here. */
  setLaunch(x, y, z) {
    this._lx = x; this._ly = y; this._lz = z;
    this.reset();
  }

  reset() {
    this.x = this._lx; this.y = this._ly; this.z = this._lz;
    this.vx = 0; this.vy = 0; this.vz = this.throttle;
  }

  weight() { return this.mass * this.g; }

  /** Current world velocity — fed back into the solver as −inlet. */
  velocity() { return [this.vx, this.vy, this.vz]; }

  /**
   * Advance by dt seconds.
   *   force     aerodynamic force on the body (N) — [fx, fy, fz], +up on y.
   *             A bare number is treated as vertical lift [0, lift, 0].
   *   throttleZ commanded forward airspeed (m/s). Omit to hold current vz.
   * Returns the new altitude (y). Clamps to the launch floor (y ≥ launch).
   */
  update(dt, force, throttleZ = undefined) {
    if (!this.enabled) return this.y;
    const fx = Array.isArray(force) ? (force[0] || 0) : 0;
    const fy = Array.isArray(force) ? (force[1] || 0) : (force || 0);
    // (fz is intentionally not integrated: forward speed is throttle-held.)

    const t = Math.min(dt, 0.05);   // small cap → stable force integration
    const m = this.mass;

    // Lateral + vertical: real aero force, gravity, light residual damping.
    this.vx += (fx / m) * t;
    this.vy += (fy / m - this.g) * t;
    this.vx -= this.damp * this.vx * t;
    this.vy -= this.damp * this.vy * t;
    this.vx = clamp(this.vx, -this.maxRate, this.maxRate);
    this.vy = clamp(this.vy, -this.maxRate, this.maxRate);

    // Forward airspeed follows the throttle (flapping maintains cruise).
    if (throttleZ !== undefined) { this.throttle = throttleZ; this.vz = throttleZ; }

    this.x += this.vx * t;
    this.y += this.vy * t;
    this.z += this.vz * t;

    if (this.y <= this._ly && this.vy < 0) { this.y = this._ly; this.vy = 0; }
    return this.y;
  }

  /** Coarse label for the HUD. */
  state() {
    if (this.y <= this._ly + 0.001 && this.vy <= 0) return 'grounded';
    if (this.vy >  0.2) return 'climbing';
    if (this.vy < -0.2) return 'sinking';
    return 'level';
  }
}
