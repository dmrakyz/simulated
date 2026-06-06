/**
 * flight-model.js — vertical + forward flight integrator.
 *
 * Vertical dynamics (semi-implicit Euler):
 *   a_y = (lift − weight) / m  −  damp·v_y
 * Ground contact clamps altitude at the launch height. Forward speed (vForward)
 * is caller-supplied throttle; no forward drag is integrated here.
 *
 * Backward-compatible: tests that only pass two args to update() continue to
 * work; x and z start at 0 unless setLaunch() is called first.
 */

export class FlightModel {
  constructor(opts = {}) {
    this.mass    = opts.mass    ?? 4;      // kg
    this.g       = opts.g       ?? 9.8;    // m/s²
    this.damp    = opts.damp    ?? 0.8;    // 1/s vertical-velocity damping
    this.maxRate = opts.maxRate ?? 12;     // m/s |v_y| cap
    this.enabled = true;
    this._lx = 0; this._ly = 0; this._lz = 0;   // launch position
    this.reset();
  }

  /** Pin the launch position; reset() returns the creature here. */
  setLaunch(x, y, z) {
    this._lx = x; this._ly = y; this._lz = z;
    this.x = x; this.y = y; this.z = z;
    this.vy = 0;
  }

  reset() { this.x = this._lx; this.y = this._ly; this.z = this._lz; this.vy = 0; }

  weight() { return this.mass * this.g; }

  /**
   * Advance by dt seconds. liftN (N, +up) drives vertical; vForward (m/s)
   * advances z. Clamps dt to 0.1 s for stability after long frames.
   * Returns new altitude (y).
   */
  update(dt, liftN, vForward = 0) {
    if (!this.enabled) return this.y;
    const t = Math.min(dt, 0.1);
    const a = (liftN - this.weight()) / this.mass;
    this.vy += a * t;
    this.vy -= this.damp * this.vy * t;
    if (this.vy >  this.maxRate) this.vy =  this.maxRate;
    if (this.vy < -this.maxRate) this.vy = -this.maxRate;
    this.y += this.vy * t;
    this.z += vForward * t;
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
