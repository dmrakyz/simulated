/**
 * flow-renderer.js — visualize the fine-grid (FAG) air velocity field as a set
 * of colored line segments (one per downsampled cell), so you can see the wake
 * and the flow bending around a wing in SIMULATE mode.
 *
 * Additive: a single LineSegments object added to the scene, hidden unless the
 * aero sim is active. Reads the `flow` snapshot produced by the worker /
 * AeroController. No per-frame allocation after the first build.
 */

export class FlowRenderer {
  constructor(THREE, scene) {
    this.THREE = THREE;
    this.scene = scene;
    this.obj = null;
    this.geom = null;
    this.maxSegs = 0;
    this.scale = 0.12;  // metres of arrow per (m/s) of speed
  }

  _ensure(nSeg) {
    const T = this.THREE;
    if (this.obj && nSeg <= this.maxSegs) return;
    if (this.obj) { this.scene.remove(this.obj); this.geom.dispose(); this.obj.material.dispose(); }
    this.maxSegs = nSeg;
    this.geom = new T.BufferGeometry();
    this.geom.setAttribute('position', new T.BufferAttribute(new Float32Array(nSeg * 6), 3));
    this.geom.setAttribute('color', new T.BufferAttribute(new Float32Array(nSeg * 6), 3));
    const mat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 });
    this.obj = new T.LineSegments(this.geom, mat);
    this.obj.frustumCulled = false;
    this.scene.add(this.obj);
  }

  setVisible(v) { if (this.obj) this.obj.visible = v; }

  /** Update from a flow snapshot { dims, origin, cellDx, vec }. */
  update(flow) {
    if (!flow) return;
    const { dims, origin, cellDx, vec } = flow;
    const [sx, sy, sz] = dims;
    const nSeg = sx * sy * sz;
    this._ensure(nSeg);

    const pos = this.geom.attributes.position.array;
    const col = this.geom.attributes.color.array;
    let p = 0, o = 0, idx = 0;
    for (let i = 0; i < sx; i++) {
      for (let j = 0; j < sy; j++) {
        for (let k = 0; k < sz; k++) {
          const vx = vec[idx], vy = vec[idx + 1], vz = vec[idx + 2];
          idx += 3;
          // Sample center in world space.
          const x = origin[0] + (i + 0.5) * cellDx;
          const y = origin[1] + (j + 0.5) * cellDx;
          const z = origin[2] + (k + 0.5) * cellDx;
          pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
          pos[p + 3] = x + vx * this.scale * cellDx * 60;
          pos[p + 4] = y + vy * this.scale * cellDx * 60;
          pos[p + 5] = z + vz * this.scale * cellDx * 60;
          p += 6;
          // Color by speed: slow = blue, fast = cyan/white.
          const spd = Math.min(1, Math.hypot(vx, vy, vz) * 8);
          const r = spd * 0.6, g = 0.4 + spd * 0.6, b = 1.0;
          col[o] = r; col[o + 1] = g; col[o + 2] = b;
          col[o + 3] = r; col[o + 4] = g; col[o + 5] = b;
          o += 6;
        }
      }
    }
    this.geom.setDrawRange(0, nSeg * 2);
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.color.needsUpdate = true;
  }
}
