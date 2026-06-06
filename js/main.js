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

  /* 12b ─ Creature aerodynamics (SIMULATE mode, additive) */
  const aero = new AeroController();
  let flowRenderer = null;
  try { flowRenderer = new FlowRenderer(THREE, scene); flowRenderer.setVisible(false); }
  catch (e) { console.warn('Flow renderer unavailable:', e.message); }

  /* 13 ─ Wire UI input */
  { const r = ldStep('Wiring UI events…');
    try { wireUI(THREE, sim, cam, tapMesh, builder, aero, flowRenderer); ldOk(r); }
    catch (e) { ldWarn(r, 'UI warning: ' + e.message); } }

  /* 14 ─ Start! */
  ldOk(ldStep(''), 'Simulation running ✓');
  hideLoader();
  setTimeout(() => { const h = document.getElementById('hint'); if (h) { h.style.opacity = '0'; setTimeout(() => h.remove(), 1200); } }, 5000);

  /* ── Render loop ────────────────────────────────────────────── */
  const fpsEl = document.getElementById('hfps');
  const pcEl  = document.getElementById('hpc');
  let _lastFpsT = 0, _fc = 0, _lastGrav = null, _lastSub = null;

  function tick(t) {
    requestAnimationFrame(tick);

    if (simP.gravity !== _lastGrav) { sim.setGravity(simP.gravity); _lastGrav = simP.gravity; }
    const sb = Math.round(simP.substeps);
    if (sb !== _lastSub) { sim.setSubsteps(sb); _lastSub = sb; }

    /* Main-thread fallback advances here; the worker advances itself. */
    if (!sim.isWorker) sim.stepLocal();

    /* Creature aerodynamics (SIMULATE mode only). */
    if (aero.active) {
      if (!aero.isWorker) aero.stepLocal();
      if (flowRenderer && aero.flow) flowRenderer.update(aero.flow);
      const f = aero.force;
      // y = lift (up/down), z = drag/thrust (along flight axis). Show separately.
      const fEl = document.getElementById('hforce');
      if (fEl) fEl.textContent = `lift ${f[1].toFixed(1)} N  drag ${Math.abs(f[2]).toFixed(1)} N`;
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
function wireUI(THREE, sim, cam, tapMesh, builder, aero, flowRenderer) {
  const DOM = sim.DOMAIN;
  let activeMat = 0, spawnSize = 1.5, mode = 'world';
  let aeroSpeed = 8, flowOn = true;

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

  /* ── SIMULATE: spin up creature aerodynamics from the built creature ── */
  function _startAero() {
    if (!aero) return;
    const parts = AeroController.partsFromBuilder(builder, THREE);
    const info = document.getElementById('aero-info');
    if (parts.length === 0) {
      if (info) info.textContent = 'No creature — build one in BUILD mode first.';
      return;
    }
    // Size the grid to the device: mobile gets half the cell count.
    // N_MAX=32 → at most 32 cells on the longest axis; phone CPUs handle this comfortably.
    const gridOpts = _isDesk
      ? { N_MAX: 64, N_SUB: [5, 3, 2] }
      : { N_MAX: 32, N_MIN: 12, N_SUB: [3, 2, 1] };

    // The creature stays visible in SIMULATE so you can watch flow around it.
    if (builder) builder.root.visible = true;
    aero.start(parts, gridOpts).then((where) => {
      aero.setVelocity([0, 0, aeroSpeed]);
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
    if (aero) aero.stop();
    if (flowRenderer) flowRenderer.setVisible(false);
    const haero = document.getElementById('haero');
    if (haero) haero.style.display = 'none';
  }

  /* SIMULATE panel controls */
  const spdEl = document.getElementById('aero-speed');
  spdEl?.addEventListener('input', e => {
    aeroSpeed = +e.target.value;
    document.getElementById('aero-spd-val').textContent = aeroSpeed;
    if (aero?.active) aero.setVelocity([0, 0, aeroSpeed]);
  });
  const flowBtn = document.getElementById('btn-flow');
  flowBtn?.addEventListener('click', () => {
    flowOn = !flowOn;
    flowBtn.classList.toggle('on', flowOn);
    flowBtn.textContent = 'Flow lines: ' + (flowOn ? 'on' : 'off');
    if (flowRenderer) flowRenderer.setVisible(flowOn && mode === 'simulate' && aero.active);
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

  /* Selected-part info readout */
  document.getElementById('c').addEventListener('creature-change', (e) => {
    const info = document.getElementById('sel-info');
    if (!info) return;
    const s = e.detail.selected;
    info.textContent = s
      ? `${PART_LABEL(s.type)} · joint: ${s.joint} · scale ${s.scale.toFixed(1)}×  (${e.detail.parts} parts)`
      : `None selected  (${e.detail.parts} parts)`;
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
