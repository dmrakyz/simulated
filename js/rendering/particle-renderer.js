/**
 * Particle Renderer — NO custom shaders.
 *
 * Uses only stock Three.js materials:
 *   Fluids (water, lava, honey, oil, air)
 *     → THREE.Points + THREE.PointsMaterial with a soft round sprite texture
 *       and per-particle vertex colours.
 *   Elastic (ice, snow)
 *     → InstancedMesh + MeshStandardMaterial, per-instance colour.
 *   Granular (sand, mud)
 *     → InstancedMesh + MeshStandardMaterial, per-instance colour.
 *
 * Snapshot stride is 4: [x, y, z, matId] per particle.
 */

import { MATERIALS } from '../mpm.js';

/* Base RGB (0..1) per material id. */
const BASE = [
  [0.13,0.55,1.00], // 0 water
  [0.85,0.70,0.37], // 1 sand
  [1.00,0.35,0.12], // 2 lava
  [0.93,0.96,1.00], // 3 snow
  [1.00,0.69,0.13], // 4 honey
  [0.48,0.35,0.22], // 5 mud
  [0.20,0.19,0.11], // 6 oil
  [0.67,0.86,1.00], // 7 ice
  [0.55,0.68,0.82], // 8 air
];

export class ParticleRenderer {
  constructor(THREE, scene, maxParticles, renderer) {
    this.THREE = THREE;
    this.scene = scene;
    this.MAX   = maxParticles;

    this._FLUID    = new Set([0,2,4,6,8]);
    this._ELASTIC  = new Set([3,7]);
    // everything else (1 sand, 5 mud) is granular

    this._dummy = new THREE.Object3D();
    this._col   = new THREE.Color();

    this._buildFluid(THREE, scene, maxParticles);
    this._buildSolid(THREE, scene, maxParticles);
    this._buildGranular(THREE, scene, maxParticles);
  }

  /* Soft radial sprite for fluid points. */
  _sprite(THREE) {
    const s = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
    grd.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grd.addColorStop(0.45,'rgba(255,255,255,0.55)');
    grd.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  _buildFluid(THREE, scene, maxP) {
    const geo = new THREE.BufferGeometry();
    this._fPos = new Float32Array(maxP * 3);
    this._fCol = new Float32Array(maxP * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this._fPos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(this._fCol, 3));
    geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      size: 0.42,
      map: this._sprite(THREE),
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
      alphaTest: 0.02,
      blending: THREE.NormalBlending,
    });
    this._fluidMesh = new THREE.Points(geo, mat);
    this._fluidMesh.frustumCulled = false;
    scene.add(this._fluidMesh);
    this._fluidGeo = geo;
  }

  _buildSolid(THREE, scene, maxP) {
    const geo = new THREE.SphereGeometry(0.17, 7, 5);
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.18, metalness: 0.0,
      transparent: true, opacity: 0.92,
    });
    this._solidMesh = new THREE.InstancedMesh(geo, mat, maxP);
    this._solidMesh.count = 0;
    this._solidMesh.frustumCulled = false;
    this._solidMesh.castShadow = true;
    scene.add(this._solidMesh);
  }

  _buildGranular(THREE, scene, maxP) {
    const geo = new THREE.SphereGeometry(0.11, 5, 4);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });
    this._granMesh = new THREE.InstancedMesh(geo, mat, maxP);
    this._granMesh.count = 0;
    this._granMesh.frustumCulled = false;
    this._granMesh.castShadow = true;
    scene.add(this._granMesh);
  }

  /* Return the base colour for a material. */
  _color(mt, out) {
    const b = BASE[mt] ?? [1,1,1];
    out.setRGB(b[0], b[1], b[2]);
    return out;
  }

  /**
   * @param {number} count
   * @param {Float32Array} data  stride 4: x,y,z,matId
   */
  update(count, data) {
    const FLU = this._FLUID, EL = this._ELASTIC;
    const fPos = this._fPos, fCol = this._fCol;
    const col = this._col;
    let fi=0, si=0, gi=0;

    for (let p=0; p<count; p++) {
      const o  = p*4;
      const x  = data[o], y = data[o+1], z = data[o+2];
      const mt = data[o+3] | 0;

      if (FLU.has(mt)) {
        const b = fi*3;
        fPos[b]=x; fPos[b+1]=y; fPos[b+2]=z;
        this._color(mt, col);
        fCol[b]=col.r; fCol[b+1]=col.g; fCol[b+2]=col.b;
        fi++;
      } else if (EL.has(mt)) {
        this._dummy.position.set(x,y,z); this._dummy.updateMatrix();
        this._solidMesh.setMatrixAt(si, this._dummy.matrix);
        this._solidMesh.setColorAt(si, this._color(mt, col));
        si++;
      } else {
        this._dummy.position.set(x,y,z); this._dummy.updateMatrix();
        this._granMesh.setMatrixAt(gi, this._dummy.matrix);
        this._granMesh.setColorAt(gi, this._color(mt, col));
        gi++;
      }
    }

    this._fluidGeo.setDrawRange(0, fi);
    this._fluidGeo.attributes.position.needsUpdate = true;
    this._fluidGeo.attributes.color.needsUpdate    = true;

    this._solidMesh.count = si;
    if (si > 0) {
      this._solidMesh.instanceMatrix.needsUpdate = true;
      if (this._solidMesh.instanceColor) this._solidMesh.instanceColor.needsUpdate = true;
    }

    this._granMesh.count = gi;
    if (gi > 0) {
      this._granMesh.instanceMatrix.needsUpdate = true;
      if (this._granMesh.instanceColor) this._granMesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of [this._fluidMesh, this._solidMesh, this._granMesh]) {
      m.geometry.dispose(); m.material.dispose(); this.scene.remove(m);
    }
  }
}
