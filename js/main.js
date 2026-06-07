/**
 * FluidCreature — Main Entry Point
 *
 * Modes:
 *   WORLD    — free camera, tap/click to pour the selected material
 *   BUILD    — creature creator (place body parts, gizmo, presets)
 *   SIMULATE — physics keeps running; drop your creature into the world
 *
 * Uses dynamic imports with try/catch at each step so any single CDN failure
 * shows a clear error in the loading panel rather than freezing on "Initializing".
 */

import { MATERIALS }        from './mpm.js';
import { SimController }     from './sim-controller.js';
import { ParticleRenderer }  from './rendering/particle-renderer.js';
import { CreatureBuilder }   from './creature/builder.js';
import { AeroController }     from './aero-controller.js';
import { FlowRenderer }       from './rendering/flow-renderer.js';
import { FlightModel }        from './flight-model.js';
import { measureCreature }    from './lbm/creature-bounds.js';

/* ── Loading-screen helpers ─────────────────────────────────────── */
const stepsEl = document.getElementById('ld-steps');
const ldEl    = document.getElementById('ld');
const appEl   = document.getElementById('app');

function ldStep(msg) {
  const row = document.createElement('div');
  row.className = 'ld-step active';
  row.innerHTML = `<span class="ld-icon">⟳</span><span class="ld-msg">${msg}</span>`;
  stepsEl.appendChild(row);
  stepsEl.scrollTop = stepsEl.scrollHeight;
  console.log('[LOAD] ' + msg);
  return row;
}
const ldOk   = (r,d) => { r.className='ld-step done';  r.querySelector('.ld-icon').textContent='✓'; if(d) r.querySelector('.ld-msg').textContent=d; };
const ldWarn = (r,d) => { r.className='ld-step warn';  r.querySelector('.ld-icon').textContent='⚠'; r.querySelector('.ld-msg').textContent=d; console.warn('[WARN]',d); };
const ldFail = (r,d) => { r.className='ld-step error'; r.querySelector('.ld-icon').textContent='✗'; r.querySelector('.ld-msg').textContent=d; console.error('[FAIL]',d); };

function hideLoader() {
  ldEl.classList.add('fade');
  appEl.classList.add('ready');
  setTimeout(() => { ldEl.style.display = 'none'; }, 500);
}

/* ── Device-tiered particle budget ──────────────────────────────────
   Physics runs in a Web Worker, so the cap is mainly a GPU upload / render
   ceiling. Desktops with many cores get a far higher budget than phones. */
const _cores  = navigator.hardwareConcurrency || 4;
const _isDesk = window.matchMedia('(pointer:fine)').matches && _cores >= 8;
const MAXP    = _isDesk ? 300000 : 50000;
const SUBSTEPS = 5;

/* ══════════════════════════════════════════════════════════════════ */
async function main() {
  let THREE, OrbitControls, Sky, GUI, TransformControls;

  /* 1 ─ Three.js */
  { const r = ldStep('Loading Three.js from CDN…');
    try { THREE = await import('three'); ldOk(r, `Three.js r${THREE.REVISION} ✓`); }
    catch (e) { ldFail(r, 'Three.js failed: ' + e.message); return; } }

  /* 2 ─ OrbitControls */
  { const r = ldStep('Loading OrbitControls…');
    try { const m = await import('three/addons/controls/OrbitControls.js'); OrbitControls = m.OrbitControls; ldOk(r); }
    catch (e) { ldWarn(r, 'OrbitControls unavailable – camera fixed'); } }

  /* 3 ─ Sky addon (optional) */
  { const r = ldStep('Loading Sky addon…');
    try { const m = await import('three/addons/objects/Sky.js'); Sky = m.Sky; ldOk(r); }
    catch (e) { ldWarn(r, 'Sky unavailable – using solid background'); } }

  /* 4 ─ lil-gui (optional) */
  { const r = ldStep('Loading lil-gui…');
    try { const m = await import('lil-gui'); GUI = m.default ?? m.GUI; ldOk(r); }
    catch (e) { ldWarn(r, 'lil-gui unavailable – properties panel disabled'); } }

  /* 5 ─ TransformControls (creature gizmo, optional) */
  { const r = ldStep('Loading TransformControls…');
    try { const m = await import('three/addons/controls/TransformControls.js'); TransformControls = m.TransformControls; ldOk(r); }
    catch (e) { ldWarn(r, 'TransformControls unavailable – gizmo disabled'); } }

  /* 6 ─ WebGL Renderer */
  let renderer;
  { const r = ldStep('Initializing WebGL renderer…');
    try {
      renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: false, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
      const isGL2 = renderer.getContext() instanceof WebGL2RenderingContext;
      ldOk(r, `WebGL${isGL2 ? '2' : ''} ready`);
    } catch (e) { ldFail(r, 'WebGL init failed: ' + e.message); return; } }

  /* 7 ─ Build 3D scene */
  const { scene, cam, orbit, tapMesh, domHelper } = await buildScene(THREE, OrbitControls, Sky, renderer);

  /* 8 ─ Physics engine (worker-backed, main-thread fallback) */
  const sim = new SimController();
  { const r = ldStep('Initializing physics engine…');
    try {
      const where = await sim.init({ gridN: 48, dx: 0.25, maxParticles: MAXP, substeps: SUBSTEPS });
      ldOk(r, `MLS-MPM on ${where === 'worker' ? 'Web Worker' : 'main thread'} · domain ${sim.DOMAIN.toFixed(1)} m · max ${MAXP.toLocaleString()}`);
    } catch (e) { ldFail(r, 'Physics init failed: ' + e.message); return; } }

  /* 9 ─ Particle renderer */
  let partRenderer;
  { const r = ldStep('Building particle renderer…');
    try { partRenderer = new ParticleRenderer(THREE, scene, MAXP); ldOk(r); }
    catch (e) { ldWarn(r, 'Particle renderer failed: ' + e.message); } }

  /* 10 ─ Demo scene */
  { const r = ldStep('Spawning demo scene…');
    try {
      const d = sim.DOMAIN;
      sim.spawnBox(d*0.42, d*0.45, d*0.42, d*0.58, d*0.62, d*0.58, 7);  // ice block
      sim.spawnBox(d*0.22, d*0.04, d*0.22, d*0.78, d*0.20, d*0.78, 0);  // water puddle
      ldOk(r, 'demo queued');
    } catch (e) { ldWarn(r, 'Spawn warning: ' + e.message); } }

  /* 11 ─ Creature builder */
  let builder;
  { const r = ldStep('Building creature editor…');
    try {
      const canvas = document.getElementById('c');
      builder = new CreatureBuilder(THREE, scene, cam, renderer, canvas);

      if (TransformControls) {
        try {
          const tc = new TransformControls(cam, canvas);
          tc.setSize(0.8);
          tc.addEventListener('dragging-changed', (ev) => { if (orbit) orbit.enabled = !ev.value; });
          // r169+ exposes getHelper(); r168 adds the controls object directly.
          scene.add(tc.getHelper ? tc.getHelper() : tc);
          builder.setTransformControls(tc);
        } catch (e) { console.warn('Gizmo init failed:', e.message); }
      }

      const inner = document.getElementById('build-panel-inner');
      if (inner) inner.innerHTML = CreatureBuilder.buildPartPanelHTML();
      ldOk(r);
    } catch (e) { ldWarn(r, 'Builder failed: ' + e.message); } }

  /* 12 ─ Properties GUI */
  const simP = { gravity: -9.8, substeps: SUBSTEPS, domain: true };
  if (GUI) {
    const r = ldStep('Building GUI…');
    try { buildGUI(GUI, simP, sim, domHelper); ldOk(r); }
    catch (e) { ldWarn(r, 'GUI failed: ' + e.message); }
  }

  /* 12b ─ Creature aerodynamics + free flight (SIMULATE mode, additive) */
  const aero = new AeroController();
  const flight = new FlightModel();
  let flowRenderer = null;
  try { flowRenderer = new FlowRenderer(THREE, scene); flowRenderer.setVisible(false); }
  catch (e) { console.warn('Flow renderer unavailable:', e.message); }

  // Active-stabilizer toggle: a shared mutable cell so tick() (here, in main's
  // closure) and the button handler (in wireUI's closure) see the same value —
  // a plain `let` would be scoped to whichever function declared it.
  const stab = { on: false };

  /* 13 ─ Wire UI input */
  { const r = ldStep('Wiring UI events…');
    try { wireUI(THREE, sim, cam, tapMesh, builder, aero, flowRenderer, flight, orbit, stab); ldOk(r); }
    catch (e) { ldWarn(r, 'UI warning: ' + e.message); } }

  /* 14 ─ Start! */
  ldOk(ldStep(''), 'Simulation running ✓');
  hideLoader();
  setTimeout(() => { const h = document.getElementById('hint'); if (h) { h.style.opacity = '0'; setTimeout(() => h.remove(), 1200); } }, 5000);

  /* ── Render loop ────────────────────────────────────────────── */
  const fpsEl = document.getElementById('hfps');
  const pcEl  = document.getElementById('hpc');
  let _lastFpsT = 0, _fc = 0, _lastGrav = null, _lastSub = null, _lastT = 0;

  function tick(t) {
    requestAnimationFrame(tick);

    if (simP.gravity !== _lastGrav) { sim.setGravity(simP.gravity); _lastGrav = simP.gravity; }
    const sb = Math.round(simP.substeps);
    if (sb !== _lastSub) { sim.setSubsteps(sb); _lastSub = sb; }

    // dt always advances so the first aero frame doesn't inherit elapsed load time.
    let dt = (t - _lastT) / 1000; _lastT = t;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.1);   // cap for tab-refocus long frames

    /* Main-thread fallback advances here; the worker advances itself. */
    if (!sim.isWorker) sim.stepLocal();

    /* Creature aerodynamics + free flight (SIMULATE mode only). */
    if (aero.active) {
      if (!aero.isWorker) aero.stepLocal();
      if (flowRenderer && aero.flow) flowRenderer.update(aero.flow);
      // The flow snapshot is creature-relative, so pin the field to wherever the
      // creature mesh actually is — every frame, whether or not free flight is
      // integrating — otherwise the streamlines drift off the body.
      if (flowRenderer?.obj && builder) flowRenderer.obj.position.copy(builder.root.position);
      const f = aero.force;

      // Free flight: integrate aero force + gravity, feed velocity back so
      // the creature feels its own motion (fall → upward wind, etc.).
      if (flight.enabled) {
        const px = flight.x, py = flight.y, pz = flight.z;

        // Scale LBM torque way down: moment-arm × force noise is large and
        // lagged, so giving it much authority tumbles the body.
        const TORQUE_SCALE = 0.06;
        const [qx, qy, qz] = flight.q;
        // Mild always-on attitude leveling: a lag-free PD pull toward wings-level
        // that keeps the noisy LBM torque from tumbling the creature (the wild
        // pitching in the bug reports). The Stabilizer toggle just stiffens it.
        const Kp = stab.on ? 8 : 3, Kd = stab.on ? 5 : 4;
        const tq = [
          aero.torque[0] * TORQUE_SCALE - Kp * qx - Kd * flight.omega[0],
          aero.torque[1] * TORQUE_SCALE - Kp * qy - Kd * flight.omega[1],
          aero.torque[2] * TORQUE_SCALE - Kp * qz - Kd * flight.omega[2],
        ];
        flight.update(dt, f, tq);
        aero.setVelocity(flight.velocity());                 // close the loop
        if (builder) builder.root.position.set(flight.x, flight.y, flight.z);
        // Apply rotation to the creature mesh (qx,qy,qz declared above for the
        // stabilizer; qw is the remaining scalar component). The flow field is
        // world-axis-aligned (the lattice doesn't rotate with the body), so the
        // creature mesh rotates but the streamline object must NOT — it stays at
        // identity and is only translated to follow the body.
        const qw = flight.q[3];
        if (builder) builder.root.quaternion.set(qx, qy, qz, qw);
        // Chase camera: translate the orbit target AND the eye by the same
        // delta, so the creature stays framed without the camera lagging behind
        // or spinning to track a receding point. User orbit/zoom still works.
        if (orbit) {
          cam.position.x += flight.x - px;
          cam.position.y += flight.y - py;
          cam.position.z += flight.z - pz;
          orbit.target.set(flight.x, flight.y, flight.z);
        }
      }

      const fEl = document.getElementById('hforce');
      if (fEl) {
        const base = `lift ${f[1].toFixed(1)} N  drag ${Math.abs(f[2]).toFixed(1)} N`;
        fEl.innerHTML = flight.enabled
          ? `${base}<br>alt ${flight.y.toFixed(1)} m · ${flight.state()} · ${flight.mass}kg`
          : base;
      }
    }

    if (orbit) orbit.update();

    /* Particle renderer (always called — count 0 clears stale geometry). */
    if (partRenderer && sim.snapshot) {
      try { partRenderer.update(sim.count, sim.snapshot); } catch (_) {}
    }

    renderer.render(scene, cam);

    _fc++;
    if (t - _lastFpsT > 700) {
      fpsEl.textContent = Math.round(_fc / (t - _lastFpsT) * 1000);
      pcEl.textContent  = sim.count.toLocaleString();
      _fc = 0; _lastFpsT = t;
    }
  }
  requestAnimationFrame(tick);
}

/* ══════════════════════════════════════════════════════════════════
   Scene builder
   ══════════════════════════════════════════════════════════════════ */
async function buildScene(THREE, OrbitControls, Sky, renderer) {
  const r      = ldStep('Building 3D scene…');
  const canvas = document.getElementById('c');
  const DOM    = 48 * 0.25; // gridN * dx = 12 m

  const scene = new THREE.Scene();
  scene.fog   = new THREE.FogExp2(0x8899bb, 0.01);

  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 800);
  cam.position.set(DOM * 0.8, DOM * 0.55, DOM * 1.1);

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  function orient() {
    const ls = window.innerWidth > window.innerHeight;
    document.body.classList.toggle('landscape', ls);
    document.body.classList.toggle('portrait',  !ls);
    document.body.classList.toggle('desk', window.innerWidth >= 900 && ls);
  }
  window.addEventListener('resize', () => { orient(); resize(); }); orient();

  /* Lighting */
  scene.add(new THREE.AmbientLight(0x334466, 0.8));
  const sun = new THREE.DirectionalLight(0xfff5dd, 1.4);
  sun.position.set(25, 50, 15); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -20;
  sun.shadow.camera.right = sun.shadow.camera.top = 20;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x6688ff, 0.4);
  fill.position.set(-15, 10, -10);
  scene.add(fill);

  /* Sky or fallback */
  if (Sky) {
    try {
      const sky = new Sky(); sky.scale.setScalar(1000); scene.add(sky);
      const su = sky.material.uniforms;
      su.turbidity.value = 3.5; su.rayleigh.value = 1.2;
      su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.82;
      const sp = new THREE.Vector3();
      sp.setFromSphericalCoords(1, THREE.MathUtils.degToRad(72), THREE.MathUtils.degToRad(190));
      su.sunPosition.value.copy(sp);
    } catch (e) { scene.background = new THREE.Color(0x88aacc); }
  } else scene.background = new THREE.Color(0x88aacc);

  /* Ground */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x3a6b2f, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  /* Domain wireframe */
  const domBox    = new THREE.Box3(new THREE.Vector3(0,0,0), new THREE.Vector3(DOM,DOM,DOM));
  const domHelper = new THREE.Box3Helper(domBox, new THREE.Color(0x005577));
  scene.add(domHelper);

  /* Invisible tap plane for pour raycasts */
  const tapMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(DOM * 6, DOM * 6),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  tapMesh.rotation.x = -Math.PI / 2; tapMesh.position.set(DOM/2, DOM/2, DOM/2); scene.add(tapMesh);

  /* OrbitControls */
  let orbit = null;
  if (OrbitControls) {
    orbit = new OrbitControls(cam, canvas);
    orbit.target.set(DOM/2, 1, DOM/2);
    orbit.enableDamping = true; orbit.dampingFactor = 0.08;
    orbit.minDistance = 1; orbit.maxDistance = 80; orbit.maxPolarAngle = Math.PI * 0.88;
    orbit.update();
  }

  ldOk(r, `Scene ready (domain ${DOM} m)`);
  return { scene, cam, orbit, tapMesh, domHelper };
}

/* ══════════════════════════════════════════════════════════════════
   GUI builder
   ══════════════════════════════════════════════════════════════════ */
function buildGUI(GUI, simP, sim, domHelper) {
  const gui = new GUI({ container: document.getElementById('gui-root'), width: 220, title: 'Settings' });
  gui.add(simP, 'gravity', -25, 0, 0.1).name('Gravity m/s²');
  gui.add(simP, 'substeps', 4, 16, 1).name('Substeps/frame');
  gui.add(simP, 'domain').name('Domain box').onChange(v => { domHelper.visible = v; });

  const actions = {
    reset() { sim.reset(); },
    water() { spawnRandom(sim, 0); },
    sand()  { spawnRandom(sim, 1); },
    lava()  { spawnRandom(sim, 2); },
    honey() { spawnRandom(sim, 4); },
    oil()   { spawnRandom(sim, 6); },
  };
  gui.add(actions, 'reset').name('⟳ Reset');
  const folder = gui.addFolder('Spawn material');
  folder.add(actions, 'water').name('+ Water');
  folder.add(actions, 'sand').name('+ Sand');
  folder.add(actions, 'lava').name('+ Lava');
  folder.add(actions, 'honey').name('+ Honey');
  folder.add(actions, 'oil').name('+ Oil');
}

function spawnRandom(sim, matId) {
  const d = sim.DOMAIN, hs = 1.0;
  const cx = hs + Math.random() * (d - hs*2);
  const cz = hs + Math.random() * (d - hs*2);
  const top = d * 0.55;
  sim.spawnBox(cx-hs, top - hs*2, cz-hs, cx+hs, top, cz+hs, matId);
}

/* ══════════════════════════════════════════════════════════════════
   UI event wiring
   ══════════════════════════════════════════════════════════════════ */
function wireUI(THREE, sim, cam, tapMesh, builder, aero, flowRenderer, flight, orbit, stab) {
  const DOM = sim.DOMAIN;
  let activeMat = 0, spawnSize = 1.5, mode = 'world';
  let flowOn = true, aoaDeg = 15;
  // Wind boost: added to the LBM world-wind inlet. Cleanly separable.
  let windOn = false, windMag = 10, windDir = [0, 0, -1];
  function _worldWind() {
    if (!windOn) return [0, 0, 0];
    const [x, y, z] = windDir;
    const len = Math.hypot(x, y, z) || 1;
    return [(x / len) * windMag, (y / len) * windMag, (z / len) * windMag];
  }
  function _pushWind() {
    const w = _worldWind();
    if (aero) aero.setWorldWind(w);
    // Keep the flight model's instantaneous drag referenced to the same wind, so
    // it damps RELATIVE airspeed (drift-with-the-air) instead of fighting the
    // boost and letting the lagged LBM force oscillate the body.
    flight.setWind(w);
  }

  // Active stabilizer: PD controller targeting identity orientation (level
  // flight). State lives in the `stab` cell shared with main()'s tick loop.
  // Camera state captured when entering SIMULATE, restored when leaving — the
  // chase camera moves the eye during flight, so both eye and target must be
  // put back or you'd return to WORLD staring in from wherever the bird ended up.
  let _savedCam = null;
  // The creature's BUILD-mode altitude, captured when entering SIMULATE and
  // restored on exit — so the bird returns to its build platform, not to
  // wherever gravity left it.
  let _buildY = 0;

  /* ── Mode tabs ─────────────────────────────────────────────── */
  document.querySelectorAll('.mbtn[data-mode]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mbtn[data-mode]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      mode = b.dataset.mode;
      _switchMode(mode);
    });
  });

  function _switchMode(m) {
    const wp = document.getElementById('world-panel');
    const bp = document.getElementById('build-panel');
    const sp = document.getElementById('sim-panel');
    if (wp) wp.style.display = (m === 'world') ? '' : 'none';
    if (bp) bp.style.display = (m === 'build') ? '' : 'none';
    if (sp) sp.style.display = (m === 'simulate') ? '' : 'none';
    if (builder) { if (m === 'build') builder.enable(); else builder.disable(); }
    if (m === 'simulate') _startAero(); else _stopAero();
  }

  /* Angle of attack is applied as a real, visible rotation of the wing/fin
     meshes about their span (local X) axis. The aero solver then reads the
     tilted geometry directly — the shape drives the lift, not a coefficient. */
  const _wingBase = new Map(); // nodeId → original rotation.x
  function _applyAoA(deg) {
    if (!builder) return;
    // Forward flight is +Z, so the Galilean far-field flows in −Z. A positive
    // AoA must pitch the leading edge up (which is −rotation.x in this frame)
    // to produce upward lift — verified by the OBB sign test.
    const rad = -deg * Math.PI / 180;
    for (const n of builder.nodes.values()) {
      if (n.type !== 'WING' && n.type !== 'FIN') continue;
      if (!_wingBase.has(n.id)) _wingBase.set(n.id, n.obj.rotation.x);
      n.obj.rotation.x = _wingBase.get(n.id) + rad;
    }
  }
  function _restoreAoA() {
    if (!builder) return;
    for (const [id, rx] of _wingBase) { const n = builder.nodes.get(id); if (n) n.obj.rotation.x = rx; }
    _wingBase.clear();
  }

  /* ── SIMULATE: spin up creature aerodynamics from the built creature ── */
  function _startAero() {
    if (!aero) return;
    _applyAoA(aoaDeg);
    const parts = AeroController.partsFromBuilder(builder, THREE);
    const info = document.getElementById('aero-info');
    if (parts.length === 0) {
      if (info) info.textContent = 'No creature — build one in BUILD mode first.';
      return;
    }
    // Boost resolution near wing surfaces: winged creatures need finer cells to
    // resolve the boundary layer and produce accurate lift at the chord surface.
    const hasWings = parts.some(p => p.type === 'WING' || p.type === 'FIN');
    const gridOpts = _isDesk
      ? { N_MAX: hasWings ? 80 : 64, N_SUB: [5, 3, 2] }
      : { N_MAX: hasWings ? 40 : 32, N_MIN: 12, N_SUB: [3, 2, 1] };

    // Remember the pre-sim camera so we can restore it on exit.
    if (orbit) _savedCam = {
      px: cam.position.x, py: cam.position.y, pz: cam.position.z,
      tx: orbit.target.x, ty: orbit.target.y, tz: orbit.target.z,
    };
    const lx = builder?.root.position.x ?? DOM / 2;
    const lz = builder?.root.position.z ?? DOM / 2;
    _buildY = builder?.root.position.y ?? 0;   // where it currently sits — the start altitude

    // Measure the creature's bounding box (parts are world positions; root is
    // currently at _buildY). The root's Y at which the creature's LOWEST point
    // rests exactly on the y=0 ground plane is offset from _buildY by however
    // far that lowest point sits below/above the root right now.
    const mb = measureCreature(parts);
    const groundY = _buildY - (mb.min[1] ?? 0);
    flight.setLaunch(lx, groundY, lz);
    flight.y = _buildY;             // start where it is — gravity brings it down to groundY
    flight.setCreatureExtent(mb.W, mb.H, mb.L);

    if (builder) { builder.root.visible = true; builder.root.position.set(lx, flight.y, lz); }
    if (flowRenderer && flowRenderer.obj) flowRenderer.obj.position.set(lx, groundY, lz);
    if (orbit) orbit.target.set(lx, groundY, lz);

    // Re-extract parts from the raised position for the LBM.
    const simParts = AeroController.partsFromBuilder(builder, THREE);
    aero.start(simParts, gridOpts).then((where) => {
      aero.setVelocity(flight.enabled ? flight.velocity() : [0, 0, 0]);
      _pushWind();
      const st = aero.stats;
      if (info && st) {
        info.innerHTML = `Running on <b>${where}</b> · ${st.totalCells.toLocaleString()} cells · ` +
          st.levels.map(l => `${l.label} ${l.dims.join('×')}`).join(' / ') +
          ` · ${st.solidCells} solid`;
      }
    }).catch((e) => { if (info) info.textContent = 'Aero failed: ' + e.message; });
    const haero = document.getElementById('haero');
    if (haero) haero.style.display = '';
    if (flowRenderer) flowRenderer.setVisible(flowOn);
  }

  function _stopAero() {
    const wasActive = aero?.active ?? false;
    if (aero) aero.stop();
    _restoreAoA();
    flight.reset();
    flight.y = _buildY;             // back to the build platform, not the ground floor
    if (builder) builder.root.position.set(flight.x, flight.y, flight.z);
    if (builder) builder.root.quaternion.set(0, 0, 0, 1);
    if (flowRenderer) {
      flowRenderer.setVisible(false);
      if (flowRenderer.obj) flowRenderer.obj.position.set(flight.x, flight.y, flight.z);
      if (flowRenderer.obj) flowRenderer.obj.quaternion.set(0, 0, 0, 1);
    }
    // Restore the pre-sim camera (eye + target) only when leaving an active sim.
    if (wasActive && orbit && _savedCam) {
      cam.position.set(_savedCam.px, _savedCam.py, _savedCam.pz);
      orbit.target.set(_savedCam.tx, _savedCam.ty, _savedCam.tz);
      _savedCam = null;
    }
    const haero = document.getElementById('haero');
    if (haero) haero.style.display = 'none';
  }

  /* SIMULATE panel controls */
  const flowBtn = document.getElementById('btn-flow');
  flowBtn?.addEventListener('click', () => {
    flowOn = !flowOn;
    flowBtn.classList.toggle('on', flowOn);
    flowBtn.textContent = 'Flow lines: ' + (flowOn ? 'on' : 'off');
    if (flowRenderer) flowRenderer.setVisible(flowOn && mode === 'simulate' && aero.active);
  });

  /* Wind boost: toggle + gust strength/direction. Just feeds the world wind. */
  const windBtn = document.getElementById('btn-wind');
  windBtn?.addEventListener('click', () => {
    windOn = !windOn;
    windBtn.classList.toggle('on', windOn);
    windBtn.textContent = 'Wind boost: ' + (windOn ? 'on' : 'off');
    const wc = document.getElementById('wind-controls');
    if (wc) wc.style.display = windOn ? '' : 'none';
    _pushWind();
  });
  document.getElementById('wind-mag')?.addEventListener('input', e => {
    windMag = +e.target.value;
    document.getElementById('wind-mag-val').textContent = windMag;
    _pushWind();
  });
  for (const [id, axis] of [['wind-dx', 0], ['wind-dy', 1], ['wind-dz', 2]]) {
    document.getElementById(id)?.addEventListener('input', e => {
      windDir[axis] = +e.target.value;
      document.getElementById(id + '-val').textContent = windDir[axis].toFixed(1);
      _pushWind();
    });
  }

  const aoaEl = document.getElementById('aero-aoa');
  aoaEl?.addEventListener('input', e => {
    aoaDeg = +e.target.value;
    document.getElementById('aero-aoa-val').textContent = aoaDeg;
    if (aero?.active && builder) {
      // Tilt the actual wing meshes (you see them rotate), then rebuild the
      // solid mask from the new geometry. Flow state continues — no full restart.
      _applyAoA(aoaDeg);
      aero.setParts(AeroController.partsFromBuilder(builder, THREE));
    }
  });

  document.getElementById('btn-restart-aero')?.addEventListener('click', () => {
    if (mode === 'simulate') { _stopAero(); _startAero(); }
  });

  /* Free flight: mass slider + on/off toggle. */
  const massEl = document.getElementById('aero-mass');
  massEl?.addEventListener('input', e => {
    flight.mass = +e.target.value;
    document.getElementById('aero-mass-val').textContent = flight.mass;
  });
  if (massEl) flight.mass = +massEl.value;
  const flyBtn = document.getElementById('btn-fly');
  flyBtn?.addEventListener('click', () => {
    flight.enabled = !flight.enabled;
    flyBtn.classList.toggle('on', flight.enabled);
    flyBtn.textContent = 'Free flight: ' + (flight.enabled ? 'on' : 'off');
    if (!flight.enabled) {
      flight.reset();
      flight.y = _buildY;           // hold at the build altitude, not the ground floor
      if (builder) {
        builder.root.position.set(flight.x, flight.y, flight.z);
        builder.root.quaternion.set(0, 0, 0, 1);
      }
      if (flowRenderer && flowRenderer.obj) flowRenderer.obj.position.set(flight.x, flight.y, flight.z);
      if (aero?.active) aero.setVelocity([0, 0, 0]);
      if (orbit) {
        if (_savedCam) cam.position.set(_savedCam.px, _savedCam.py, _savedCam.pz);
        orbit.target.set(flight.x, flight.y, flight.z);
      }
    } else if (aero?.active) {
      aero.setVelocity(flight.velocity());
    }
  });

  /* Active stabilizer toggle. */
  const stabBtn = document.getElementById('btn-stab');
  stabBtn?.addEventListener('click', () => {
    stab.on = !stab.on;
    stabBtn.classList.toggle('on', stab.on);
    stabBtn.textContent = 'Stabilizer: ' + (stab.on ? 'on' : 'off');
  });

  /* ── Material selector ─────────────────────────────────────── */
  document.querySelectorAll('.mfbtn[data-m]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mfbtn[data-m]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      activeMat = +b.dataset.m;
      document.getElementById('hmat').textContent = MATERIALS[activeMat]?.name ?? activeMat;
    });
  });

  /* ── Creature builder controls ─────────────────────────────── */
  document.querySelectorAll('.part-btn[data-part]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.part-btn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      builder?.setActivePart(b.dataset.part);
    });
  });
  document.querySelectorAll('[data-preset]').forEach(b => {
    b.addEventListener('click', () => builder?.loadPreset(b.dataset.preset));
  });
  const btnMove = document.getElementById('btn-move');
  const btnRot  = document.getElementById('btn-rotate');
  btnMove?.addEventListener('click', () => { builder?.setGizmoMode('translate'); btnMove.classList.add('on'); btnRot?.classList.remove('on'); });
  btnRot ?.addEventListener('click', () => { builder?.setGizmoMode('rotate');    btnRot.classList.add('on'); btnMove?.classList.remove('on'); });
  document.querySelectorAll('[data-joint]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-joint]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      builder?.setJointType(b.dataset.joint);
    });
  });
  document.getElementById('btn-rotx')?.addEventListener('click', () => builder?.rotateSelected('x', 15));
  document.getElementById('btn-roty')?.addEventListener('click', () => builder?.rotateSelected('y', 15));
  const btnMir = document.getElementById('btn-mirror');
  btnMir?.addEventListener('click', () => { const on = builder?.toggleMirror(); btnMir.classList.toggle('on', on); btnMir.textContent = 'Mirror: ' + (on ? 'on' : 'off'); });
  document.getElementById('btn-del')?.addEventListener('click',   () => builder?.deleteSelected());
  document.getElementById('btn-clear')?.addEventListener('click', () => builder?.clearAll());
  document.getElementById('btn-save')?.addEventListener('click',  () => builder?.save());
  document.getElementById('btn-load')?.addEventListener('click',  () => { if (!builder?.load()) alert('No saved creature.'); });

  const chainEl = document.getElementById('chain-len');
  chainEl?.addEventListener('input', e => {
    document.getElementById('chain-val').textContent = e.target.value;
    builder?.setChainLength(+e.target.value);
  });
  const scaleEl = document.getElementById('part-scale');
  scaleEl?.addEventListener('input', e => {
    document.getElementById('scale-val').textContent = (+e.target.value).toFixed(1);
    builder?.scaleSelected(+e.target.value);
  });
  ['x','y','z'].forEach(ax => {
    const id = `part-scale-${ax}`;
    document.getElementById(id)?.addEventListener('input', e => {
      const v = +e.target.value;
      document.getElementById(`scale-${ax}-val`).textContent = v.toFixed(1);
      builder?.scaleAxisSelected(ax, v);
    });
  });

  /* Wing shape sliders — only visible when a WING or FIN is selected. */
  document.getElementById('wng-cam')?.addEventListener('input', e => {
    const v = +e.target.value / 100;
    document.getElementById('wng-cam-val').textContent = (+e.target.value).toFixed(1);
    builder?.updateSelectedAirfoil('m', v);
  });
  document.getElementById('wng-thk')?.addEventListener('input', e => {
    const v = +e.target.value / 100;
    document.getElementById('wng-thk-val').textContent = e.target.value;
    builder?.updateSelectedAirfoil('t', v);
  });
  document.getElementById('wng-cp')?.addEventListener('input', e => {
    const v = +e.target.value / 100;
    document.getElementById('wng-cp-val').textContent = e.target.value;
    builder?.updateSelectedAirfoil('p', v);
  });
  document.getElementById('wng-sw')?.addEventListener('input', e => {
    const deg = +e.target.value;
    const v = deg * Math.PI / 180;
    document.getElementById('wng-sw-val').textContent = deg;
    builder?.updateSelectedAirfoil('sweep', v);
  });

  /* Selected-part info readout + wing-shape panel show/hide. */
  document.getElementById('c').addEventListener('creature-change', (e) => {
    const info = document.getElementById('sel-info');
    if (!info) return;
    const s = e.detail.selected;
    info.textContent = s
      ? `${PART_LABEL(s.type)} · joint: ${s.joint} · scale ${s.scale.toFixed(1)}×  (${e.detail.parts} parts)`
      : `None selected  (${e.detail.parts} parts)`;

    // Show wing shape panel when a WING or FIN is selected; populate with its params.
    const wingPanel = document.getElementById('wing-shape-panel');
    if (!wingPanel) return;
    const isWing = s && (s.type === 'WING' || s.type === 'FIN');
    wingPanel.style.display = isWing ? '' : 'none';
    if (isWing) {
      const af = builder?.getSelectedAirfoil();
      if (af) {
        const camPct = (af.m * 100).toFixed(1);
        const thkPct = Math.round(af.t * 100);
        const cpPct  = Math.round(af.p * 100);
        const camEl = document.getElementById('wng-cam');
        const thkEl = document.getElementById('wng-thk');
        const cpEl  = document.getElementById('wng-cp');
        if (camEl) { camEl.value = camPct; document.getElementById('wng-cam-val').textContent = camPct; }
        if (thkEl) { thkEl.value = thkPct; document.getElementById('wng-thk-val').textContent = thkPct; }
        if (cpEl)  { cpEl.value  = cpPct;  document.getElementById('wng-cp-val').textContent  = cpPct; }
        const swEl = document.getElementById('wng-sw');
        if (swEl) {
          const swDeg = Math.round((af.sweep ?? 0) * 180 / Math.PI);
          swEl.value = swDeg;
          document.getElementById('wng-sw-val').textContent = swDeg;
        }
      }
    }

    // Populate per-axis scale sliders from the selected part's current scale.
    const selNode = builder?.selected;
    if (selNode) {
      const sc = selNode.obj.scale;
      const sx = document.getElementById('part-scale-x');
      const sy = document.getElementById('part-scale-y');
      const sz = document.getElementById('part-scale-z');
      if (sx) { sx.value = Math.abs(sc.x).toFixed(1); document.getElementById('scale-x-val').textContent = Math.abs(sc.x).toFixed(1); }
      if (sy) { sy.value = sc.y.toFixed(1); document.getElementById('scale-y-val').textContent = sc.y.toFixed(1); }
      if (sz) { sz.value = sc.z.toFixed(1); document.getElementById('scale-z-val').textContent = sc.z.toFixed(1); }
    }
  });

  /* ── Panel toggles ─────────────────────────────────────────── */
  document.getElementById('fab-panel')?.addEventListener('click', () => document.body.classList.toggle('lp-open'));
  document.getElementById('btn-rp')?.addEventListener('click',    () => document.body.classList.toggle('rp-open'));

  /* ── Spawn size ────────────────────────────────────────────── */
  const szEl = document.getElementById('spawn-size');
  szEl?.addEventListener('input', e => { spawnSize = +e.target.value; document.getElementById('size-label').textContent = spawnSize; });

  /* ── FAB spawn ─────────────────────────────────────────────── */
  document.getElementById('fab-spawn')?.addEventListener('click', () => spawnRandom(sim, activeMat));

  /* ── Tap-to-pour (WORLD mode only; builder owns clicks in BUILD) ── */
  const ray = new THREE.Raycaster(), rv2 = new THREE.Vector2();
  let ptrDn = null;
  const canvas = document.getElementById('c');

  // Prevent right-click / long-press context menu on the canvas.
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // Belt-and-suspenders with the CSS user-select rules: kill any text-selection
  // gesture that starts on the canvas (the long-press "blue box" that otherwise
  // captures the pointer and freezes OrbitControls until you tap to deselect).
  canvas.addEventListener('selectstart', e => e.preventDefault());

  canvas.addEventListener('pointerdown', e => { ptrDn = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!ptrDn || mode !== 'world') { ptrDn = null; return; }
    const dx = e.clientX - ptrDn[0], dy = e.clientY - ptrDn[1];
    if (Math.sqrt(dx*dx + dy*dy) < 12) {
      const rect = canvas.getBoundingClientRect();
      rv2.set(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1);
      ray.setFromCamera(rv2, cam);
      const hits = ray.intersectObject(tapMesh);
      if (hits.length) {
        const pt = hits[0].point, hs = spawnSize/2;
        const cx = Math.max(hs+0.5, Math.min(DOM-hs-0.5, pt.x));
        const cz = Math.max(hs+0.5, Math.min(DOM-hs-0.5, pt.z));
        const cy = Math.min(DOM-hs-0.5, pt.y + spawnSize*1.5);
        sim.spawnBox(cx-hs, cy-spawnSize, cz-hs, cx+hs, cy, cz+hs, activeMat);
      }
    }
    ptrDn = null;
  });

  _switchMode('world');
}

/* Pretty label for a part type key (falls back to the key itself). */
function PART_LABEL(type) {
  return type.charAt(0) + type.slice(1).toLowerCase();
}

/* ── Entry point ──────────────────────────────────────────────────── */
main().catch(e => {
  console.error('Fatal startup error:', e.message, e.stack);
  const r = ldStep('Fatal error — check console panel above');
  ldFail(r, String(e));
  if (window.ErrPanel) window.ErrPanel.open();
});
