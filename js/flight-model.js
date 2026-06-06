/**
 * flight-model.js — turns the aerodynamic force from the LBM into actual
 * motion, so the creature flies instead of hanging in a wind tunnel.
 *
 * Kept deliberately simple and stable: a 1-DOF vertical model. The user sets
 * forward speed (throttle) and angle of attack; those determine the lift the
 * LBM measures; this model integrates lift vs weight to make the creature
 * climb, glide, stall-and-sink, or settle into level flight. Forward and
 * lateral motion are left to the throttle/steering so the creature stays in
 * frame and the model can't diverge.
 *
 * Vertical dynamics (semi-implicit Euler):
 *   a = (lift − weight) / m  −  c·v_y      (linear damping tames oscillation)
 * Ground contact clamps at the launch height. Pure data — unit-tested.
 */

export class FlightModel {
  constructor(opts = {}) {
    this.mass = opts.mass ?? 4;      // kg
    this.g = opts.g ?? 9.8;          // m/s²
    this.damp = opts.damp ?? 0.8;    // 1/s vertical velocity damping
    this.maxRate = opts.maxRate ?? 12; // clamp |v_y| (m/s) so it never bolts
    this.enabled = true;
    this.reset();
  }

  reset() { this.y = 0; this.vy = 0; }   // y = altitude above launch (m)

  weight() { return this.mass * this.g; }

  /**
   * Advance the vertical state by dt seconds given the current lift (N, +up).
   * Returns the new altitude. Clamps to the launch floor (y ≥ 0).
   */
  update(dt, liftN) {
    if (!this.enabled) return this.y;
    // Sub-step for stability if a frame is long (e.g. tab refocus).
    let t = Math.min(dt, 0.1);
    const a = (liftN - this.weight()) / this.mass;
    this.vy += a * t;
    this.vy -= this.damp * this.vy * t;
    if (this.vy > this.maxRate) this.vy = this.maxRate;
    if (this.vy < -this.maxRate) this.vy = -this.maxRate;
    this.y += this.vy * t;
    if (this.y <= 0 && this.vy < 0) { this.y = 0; this.vy = 0; } // on the ground
    return this.y;
  }

  /** A coarse label for the HUD. */
  state() {
    if (this.y <= 0.001 && this.vy <= 0) return 'grounded';
    if (this.vy > 0.2) return 'climbing';
    if (this.vy < -0.2) return 'sinking';
    return 'level';
  }
}
