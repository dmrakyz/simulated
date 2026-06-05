/**
 * Particle Renderer — InstancedMesh spheres for all particle types.
 * Matches the original "first working" visual: one colored sphere per particle.
 *
 * Stride-4 input: [x, y, z, matId] per particle.
 */

import { MATERIALS } from '../mpm.js';

const MAT_COLS = MATERIALS.map(m => m.col);

export class ParticleRenderer {
  constructor(THREE, scene, maxParticles) {
    this.THREE = THREE;
    this.scene = scene;
    this.MAX   = maxParticles;

    this._dummy = new THREE.Object3D();
    this._col   = new THREE.Color();

    this._buildMesh(THREE, scene, maxParticles);
  }

  _buildMesh(THREE, scene, maxP) {
    const geo = new THREE.SphereGeometry(0.14, 6, 4);
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.55,
      metalness: 0.05,
      transparent: true,
      opacity: 0.93,
    });
    this._mesh = new THREE.InstancedMesh(geo, mat, maxP);
    this._mesh.count = 0;
    this._mesh.frustumCulled = false;
    this._mesh.castShadow = true;
    scene.add(this._mesh);
  }

  /**
   * @param {number} count
   * @param {Float32Array} data  stride 4: x, y, z, matId
   */
  update(count, data) {
    const dummy = this._dummy;
    const col   = this._col;
    const mesh  = this._mesh;
    let n = 0;

    for (let p = 0; p < count; p++) {
      const o  = p * 4;
      const mt = data[o + 3] | 0;
      if (mt === 8) continue;  // air is the implicit background — not rendered

      dummy.position.set(data[o], data[o + 1], data[o + 2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);

      col.setHex(MAT_COLS[mt] ?? 0xffffff);
      mesh.setColorAt(n, col);
      n++;
    }

    mesh.count = n;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    this.scene.remove(this._mesh);
  }
}
