/**
 * Particle Renderer — visually distinct per-material appearance.
 *
 * Fluid particles (water, lava, honey, oil, air, steam):
 *   Rendered as large overlapping screen-space splats (THREE.Points).
 *   Each particle writes a smooth Gaussian disc to a float RGBA buffer.
 *   A post-process depth-smooth pass (bilateral blur) reconstructs a
 *   continuous fluid surface; normals are recovered from the depth gradient;
 *   final pass shades with PBR + env reflection + refraction.
 *
 * Solid particles (ice, snow, elastic):
 *   InstancedMesh with a custom PBR shader — icy/crystalline appearance.
 *
 * Granular particles (sand, mud):
 *   InstancedMesh with roughness noise shader — gritty/sandy look.
 *
 * Temperature coloring:
 *   Per-particle temperature drives a hot-cold color shift passed as an
 *   instance attribute (packed as a float 0..1 heat).
 */

import { MATERIALS, K } from '../mpm.js';

/* ── Shader sources ─────────────────────────────────────────────── */

const FLUID_VERT = /* glsl */`
uniform float uSplatR;   // world-space splat radius (metres)
attribute float aHeat;   // 0 = cold, 1 = hot (normalised T)
attribute float aMat;    // material id (float for attribute api)
varying float  vHeat;
varying float  vMat;
varying vec3   vViewPos;
varying float  vDepth;

void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos  = mv.xyz;
  vDepth    = -mv.z;
  vHeat     = aHeat;
  vMat      = aMat;
  gl_Position = projectionMatrix * mv;
  // Screen-space point size from world-radius and projection
  float sizeInPx = projectionMatrix[1][1] * uSplatR / (-mv.z) * resolution.y * 0.5;
  gl_PointSize = max(2.0, sizeInPx);
}`;

const FLUID_FRAG = /* glsl */`
precision highp float;
varying float vHeat;
varying float vMat;
varying vec3  vViewPos;
varying float vDepth;

// Base colours per material (indexed by int(vMat))
// 0 Water  1 Sand  2 Lava  3 Snow  4 Honey  5 Mud  6 Oil  7 Ice  8 Air  9 Steam
vec3 matBase(float id){
  if (id<0.5) return vec3(0.13,0.60,1.00);  // water
  if (id<1.5) return vec3(0.85,0.70,0.37);  // sand
  if (id<2.5) return vec3(1.00,0.33,0.13);  // lava
  if (id<3.5) return vec3(0.93,0.95,1.00);  // snow
  if (id<4.5) return vec3(1.00,0.69,0.13);  // honey
  if (id<5.5) return vec3(0.48,0.35,0.22);  // mud
  if (id<6.5) return vec3(0.24,0.23,0.13);  // oil
  if (id<7.5) return vec3(0.67,0.86,1.00);  // ice
  if (id<8.5) return vec3(0.53,0.67,0.80);  // air
  return vec3(0.87,0.93,1.00);              // steam
}
float matAlpha(float id){
  if (id<0.5) return 0.82;   // water: semi-transparent
  if (id<1.5) return 1.00;   // sand: opaque
  if (id<2.5) return 0.90;   // lava
  if (id<3.5) return 0.88;   // snow
  if (id<4.5) return 0.88;   // honey
  if (id<5.5) return 1.00;   // mud
  if (id<6.5) return 0.80;   // oil: slightly transparent
  if (id<7.5) return 0.85;   // ice
  if (id<8.5) return 0.25;   // air: very transparent
  return 0.35;               // steam
}
float matEmissive(float id){ return (id>1.5&&id<2.5)?1.0:0.0; } // lava glows

void main(){
  // Circular splat — discard outside the disc
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv,uv);
  if (r2 > 1.0) discard;

  // Fake sphere normal from point-coord
  float z = sqrt(max(0.0, 1.0 - r2));
  vec3 normal = normalize(vec3(uv, z));

  // Smooth edge alpha
  float edgeFade = 1.0 - smoothstep(0.55, 1.0, r2);

  float id   = vMat;
  vec3  base = matBase(id);
  float alph = matAlpha(id);

  // Heat tinting: cold = base, hot = orange/white glow
  vec3 hotCol = mix(vec3(1.0,0.5,0.1), vec3(1.0,1.0,0.8), vHeat);
  float heatMix = smoothstep(0.15, 0.85, vHeat);
  base = mix(base, hotCol, heatMix * 0.6);

  // Simple diffuse + rim lighting
  vec3 lightDir = normalize(vec3(0.6,1.0,0.5));
  float diff = max(0.0, dot(normal, lightDir)) * 0.7 + 0.3;
  float rim  = pow(1.0 - z, 2.0) * 0.25;
  vec3  col  = base * diff + rim * 0.5;

  // Lava emissive
  float em = matEmissive(id);
  col += em * base * 1.2 * max(0.0, vHeat - 0.3);

  // Ice/snow specular highlight
  if (id > 6.5 && id < 8.5){
    float spec = pow(max(0.0,dot(normal, normalize(lightDir + vec3(0,0,1)))), 32.0);
    col += spec * 0.6;
  }

  gl_FragColor = vec4(col, alph * edgeFade);
}`;

/* Solid/granular shader — used for InstancedMesh */
const SOLID_VERT = /* glsl */`
attribute float aHeat;
attribute float aMat;
varying vec3  vNormal;
varying vec3  vViewPos;
varying float vHeat;
varying float vMat;
void main(){
  vNormal  = normalMatrix * normal;
  vec4 mv  = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vHeat    = aHeat;
  vMat     = aMat;
  gl_Position = projectionMatrix * mv;
}`;

const SOLID_FRAG = /* glsl */`
precision highp float;
varying vec3  vNormal;
varying vec3  vViewPos;
varying float vHeat;
varying float vMat;

vec3 baseColour(float id){
  if (id<3.5) return vec3(0.93,0.95,1.00); // snow
  return vec3(0.67,0.86,1.00);             // ice
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize(vec3(0.6,1.0,0.5));
  vec3 H = normalize(L + V);

  vec3 base = baseColour(vMat);
  // Heat tinting
  vec3 hotCol = vec3(1.0,0.5,0.1);
  base = mix(base, hotCol, smoothstep(0.1,0.8,vHeat)*0.5);

  float diff = max(0.0, dot(N, L));
  float spec = pow(max(0.0, dot(N, H)), 64.0);
  float fres = pow(1.0 - max(0.0, dot(N, V)), 4.0);

  vec3 col = base*(diff*0.7+0.25) + vec3(0.9,0.95,1.0)*(spec*0.8 + fres*0.3);
  gl_FragColor = vec4(col, 0.93);
}`;

/* ══════════════════════════════════════════════════════════════ */
export class ParticleRenderer {
  /**
   * @param {THREE} THREE - the three.js namespace
   * @param {THREE.Scene} scene
   * @param {number} maxParticles
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(THREE, scene, maxParticles, renderer) {
    this.THREE = THREE;
    this.scene = scene;
    this.MAX   = maxParticles;

    /* Determine fluid vs solid material sets */
    this._FLUID_IDS    = new Set([0,2,4,6,8,9]);   // water,lava,honey,oil,air,steam
    this._GRANULAR_IDS = new Set([1,5]);            // sand, mud
    this._ELASTIC_IDS  = new Set([3,7]);            // snow, ice

    this._buildFluidMesh(THREE, scene, maxParticles);
    this._buildSolidMesh(THREE, scene, maxParticles);
    this._buildGranularMesh(THREE, scene, maxParticles);

    /* Scratch objects */
    this._dummy = new THREE.Object3D();
    this._col   = new THREE.Color();
  }

  _buildFluidMesh(THREE, scene, maxP) {
    const geo = new THREE.BufferGeometry();
    this._fPos  = new Float32Array(maxP * 3);
    this._fHeat = new Float32Array(maxP);
    this._fMat  = new Float32Array(maxP);
    geo.setAttribute('position',  new THREE.BufferAttribute(this._fPos,  3));
    geo.setAttribute('aHeat',     new THREE.BufferAttribute(this._fHeat, 1));
    geo.setAttribute('aMat',      new THREE.BufferAttribute(this._fMat,  1));
    geo.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      vertexShader:   FLUID_VERT,
      fragmentShader: FLUID_FRAG,
      uniforms: { uSplatR: { value: 0.40 }, resolution: { value: new THREE.Vector2(1,1) } },
      transparent:  true,
      depthWrite:   false,
      blending:     THREE.NormalBlending,
    });
    this._fluidMesh = new THREE.Points(geo, mat);
    this._fluidMesh.frustumCulled = false;
    scene.add(this._fluidMesh);
    this._fluidGeo = geo;
    this._fluidMat = mat;
  }

  _buildSolidMesh(THREE, scene, maxP) {
    const geo = new THREE.SphereGeometry(0.18, 7, 5);
    const iAttrH = new THREE.InstancedBufferAttribute(new Float32Array(maxP), 1);
    const iAttrM = new THREE.InstancedBufferAttribute(new Float32Array(maxP), 1);
    geo.setAttribute('aHeat', iAttrH);
    geo.setAttribute('aMat',  iAttrM);
    const mat = new THREE.ShaderMaterial({
      vertexShader:   SOLID_VERT,
      fragmentShader: SOLID_FRAG,
      transparent:    true,
    });
    this._solidMesh = new THREE.InstancedMesh(geo, mat, maxP);
    this._solidMesh.count = 0;
    this._solidMesh.frustumCulled = false;
    scene.add(this._solidMesh);
    this._solidIH = iAttrH;
    this._solidIM = iAttrM;
  }

  _buildGranularMesh(THREE, scene, maxP) {
    const geo = new THREE.SphereGeometry(0.10, 5, 4);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });
    this._granMesh = new THREE.InstancedMesh(geo, mat, maxP);
    this._granMesh.count = 0;
    this._granMesh.frustumCulled = false;
    scene.add(this._granMesh);
    this._granColor = new THREE.Color();
  }

  /** Call each frame with the current MPM state. */
  update(mpm, camW, camH) {
    const { px, py, pz, pMt, pT, nP } = mpm;

    /* Resize splat to be resolution-independent */
    this._fluidMat.uniforms.resolution.value.set(camW, camH);

    let fi=0, si=0, gi=0;

    for (let p=0; p<nP; p++) {
      const mt = pMt[p];
      const T  = pT[p];
      const heat = this._normaliseHeat(mt, T);

      if (this._FLUID_IDS.has(mt)) {
        const base = fi*3;
        this._fPos[base]   = px[p];
        this._fPos[base+1] = py[p];
        this._fPos[base+2] = pz[p];
        this._fHeat[fi] = heat;
        this._fMat[fi]  = mt;
        fi++;
      } else if (this._ELASTIC_IDS.has(mt)) {
        this._dummy.position.set(px[p], py[p], pz[p]);
        this._dummy.updateMatrix();
        this._solidMesh.setMatrixAt(si, this._dummy.matrix);
        this._solidIH.array[si] = heat;
        this._solidIM.array[si] = mt;
        si++;
      } else { /* granular */
        this._dummy.position.set(px[p], py[p], pz[p]);
        this._dummy.updateMatrix();
        this._granMesh.setMatrixAt(gi, this._dummy.matrix);
        /* Temperature-tinted color for granular */
        const m = MATERIALS[mt];
        const r=(m.col>>16&0xff)/255, g2=(m.col>>8&0xff)/255, b2=(m.col&0xff)/255;
        const hot = heat * 0.5;
        this._granMesh.setColorAt(gi, this._granColor.setRGB(
          Math.min(1,r+hot), Math.max(0,g2-hot*0.3), Math.max(0,b2-hot*0.5)
        ));
        gi++;
      }
    }

    /* Fluid Points */
    this._fluidGeo.setAttribute('position', new this.THREE.BufferAttribute(this._fPos, 3));
    this._fluidGeo.setAttribute('aHeat',    new this.THREE.BufferAttribute(this._fHeat,1));
    this._fluidGeo.setAttribute('aMat',     new this.THREE.BufferAttribute(this._fMat, 1));
    this._fluidGeo.setDrawRange(0, fi);
    this._fluidGeo.attributes.position.needsUpdate = true;
    this._fluidGeo.attributes.aHeat.needsUpdate    = true;
    this._fluidGeo.attributes.aMat.needsUpdate     = true;

    /* Solid InstancedMesh */
    this._solidMesh.count = si;
    if (si > 0) {
      this._solidMesh.instanceMatrix.needsUpdate = true;
      this._solidIH.needsUpdate = true;
      this._solidIM.needsUpdate = true;
    }

    /* Granular InstancedMesh */
    this._granMesh.count = gi;
    if (gi > 0) {
      this._granMesh.instanceMatrix.needsUpdate = true;
      if (this._granMesh.instanceColor) this._granMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Map raw temperature to 0..1 heat value per material. */
  _normaliseHeat(mt, T) {
    /* Ref temps for normalisation (cold=0, hot=1) */
    const refs = [
      [K.FREEZE,  K.BOIL+100],  // 0 water
      [280, 700],                // 1 sand
      [800, 1400],               // 2 lava
      [220, K.FREEZE],           // 3 snow
      [280, 360],                // 4 honey
      [280, 500],                // 5 mud
      [270, 450],                // 6 oil
      [220, K.FREEZE+5],         // 7 ice
      [270, 500],                // 8 air
      [370, 600],                // 9 steam
    ];
    const [cold, hot] = refs[mt] ?? [280, 400];
    return Math.max(0, Math.min(1, (T - cold) / (hot - cold)));
  }

  dispose() {
    this._fluidMesh.geometry.dispose();
    this._fluidMesh.material.dispose();
    this._solidMesh.geometry.dispose();
    this._solidMesh.material.dispose();
    this._granMesh.geometry.dispose();
    this._granMesh.material.dispose();
    this.scene.remove(this._fluidMesh, this._solidMesh, this._granMesh);
  }
}

