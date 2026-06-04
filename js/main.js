/**
 * FluidCreature — Main Entry Point
 *
 * Modes:
 *   WORLD    — free-camera, tap/click to pour materials, heat interactions
 *   BUILD    — creature creator (place body parts, joints, muscles)
 *   SIMULATE — drop creature into world and run physics
 */

import { MATERIALS }        from './mpm.js';
import { SimController }     from './sim-controller.js';
import { ParticleRenderer }  from './rendering/particle-renderer.js';
import { CreatureBuilder }   from './creature/builder.js';

/* ── Device tier ──────────────────────────────────────────────── */
const _cores  = navigator.hardwareConcurrency || 4;
const _isDesk = window.matchMedia('(pointer:fine)').matches && _cores >= 8;
const MAXP    = _isDesk ? 300000 : 60000;
const SUBS    = 5;

/* ── Loading helpers ──────────────────────────────────────────── */
const stepsEl = document.getElementById('ld-steps');
const ldEl    = document.getElementById('ld');
const appEl   = document.getElementById('app');

function ldStep(msg) {
  const row = document.createElement('div');
  row.className = 'ld-step active';
  row.innerHTML = `<span class="ld-icon">⟳</span><span class="ld-msg">${msg}</span>`;
  stepsEl.appendChild(row);
  stepsEl.scrollTop = stepsEl.scrollHeight;
  return row;
}
const ldOk   = (r,d) => { r.className='ld-step done';  r.querySelector('.ld-icon').textContent='✓'; if(d) r.querySelector('.ld-msg').textContent=d; };
const ldWarn = (r,d) => { r.className='ld-step warn';  r.querySelector('.ld-icon').textContent='⚠'; r.querySelector('.ld-msg').textContent=d; console.warn('[WARN]',d); };
const ldFail = (r,d) => { r.className='ld-step error'; r.querySelector('.ld-icon').textContent='✗'; r.querySelector('.ld-msg').textContent=d; console.error('[FAIL]',d); };

function hideLoader() {
  ldEl.classList.add('fade');
  appEl.classList.add('ready');
  setTimeout(() => { ldEl.style.display='none'; }, 500);
}

/* ══════════════════════════════════════════════════════════════ */
async function main() {
  let THREE, OrbitControls, Sky, GUI, EffectComposer, UnrealBloomPass, RenderPass, TransformControls;

  /* 1 ── Three.js */
  { const r=ldStep('Loading Three.js…');
    try { THREE=await import('three'); ldOk(r,`Three r${THREE.REVISION}`); }
    catch(e) { ldFail(r,'Three.js failed: '+e.message); return; } }

  /* 2 ── OrbitControls */
  { const r=ldStep('OrbitControls…');
    try { const m=await import('three/addons/controls/OrbitControls.js'); OrbitControls=m.OrbitControls; ldOk(r); }
    catch(e) { ldWarn(r,'OrbitControls unavailable'); } }

  /* 3 ── Sky */
  { const r=ldStep('Sky addon…');
    try { const m=await import('three/addons/objects/Sky.js'); Sky=m.Sky; ldOk(r); }
    catch(e) { ldWarn(r,'Sky unavailable'); } }

  /* 4 ── Post-processing (bloom) */
  { const r=ldStep('Post-processing…');
    try {
      const a=await import('three/addons/postprocessing/EffectComposer.js');
      const b=await import('three/addons/postprocessing/RenderPass.js');
      const c=await import('three/addons/postprocessing/UnrealBloomPass.js');
      EffectComposer=a.EffectComposer; RenderPass=b.RenderPass; UnrealBloomPass=c.UnrealBloomPass;
      ldOk(r);
    } catch(e) { ldWarn(r,'Bloom unavailable ('+e.message+')'); } }

  /* 5 ── lil-gui */
  { const r=ldStep('lil-gui…');
    try { const m=await import('lil-gui'); GUI=(m.default??m.GUI); ldOk(r); }
    catch(e) { ldWarn(r,'lil-gui unavailable'); } }

  /* 5b ── TransformControls (creature gizmo) */
  { const r=ldStep('TransformControls…');
    try { const m=await import('three/addons/controls/TransformControls.js'); TransformControls=m.TransformControls; ldOk(r); }
    catch(e) { ldWarn(r,'TransformControls unavailable – gizmo disabled'); } }

  /* 6 ── WebGL renderer */
  let renderer;
  { const r=ldStep('WebGL renderer…');
    try {
      renderer=new THREE.WebGLRenderer({ canvas:document.getElementById('c'), antialias:false, powerPreference:'high-performance' });
      renderer.setPixelRatio(Math.min(devicePixelRatio,2));
      renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
      renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.0;
      ldOk(r,'WebGL'+((renderer.getContext() instanceof WebGL2RenderingContext)?'2':'')+' ready');
    } catch(e) { ldFail(r,'WebGL failed: '+e.message); return; } }

  /* 7 ── Scene */
  const { scene, cam, orbit, tapMesh, domHelper } = await buildScene(THREE, OrbitControls, Sky, renderer);

  /* 8 ── (bloom removed — render directly, no glow) */
  let composer = null;

  /* 9 ── Physics engine (worker-backed, main-thread fallback) */
  const sim = new SimController();
  { const r=ldStep('Physics engine…');
    try {
      const where = await sim.init({ gridN:48, dx:0.25, maxParticles:MAXP, substeps:SUBS });
      ldOk(r, `MLS-MPM on ${where==='worker'?'Web Worker':'main thread'} · domain ${sim.DOMAIN.toFixed(1)} m · max ${MAXP.toLocaleString()}`);
    } catch(e) { ldFail(r,'Physics failed: '+e.message); return; } }

  /* 10 ── Particle renderer */
  let partRenderer;
  { const r=ldStep('Particle renderer…');
    try { partRenderer=new ParticleRenderer(THREE, scene, MAXP, renderer); ldOk(r); }
    catch(e) { ldWarn(r,'Particle renderer failed: '+e.message); } }

  /* 11 ── Demo scene */
  { const r=ldStep('Spawning demo…');
    try {
      const d=sim.DOMAIN;
      sim.spawnBox(d*.42, d*.45, d*.42, d*.58, d*.62, d*.58, 7);   // ice block
      sim.spawnBox(d*.22, d*.04, d*.22, d*.78, d*.20, d*.78, 0);   // water
      ldOk(r, 'demo queued');
    } catch(e) { ldWarn(r,'Spawn: '+e.message); } }

  /* 12 ── Creature builder */
  let builder;
  { const r=ldStep('Creature builder…');
    try {
      const canvas=document.getElementById('c');
      builder=new CreatureBuilder(THREE, scene, cam, renderer, canvas);

      /* TransformControls gizmo (optional) */
      if (TransformControls) {
        try {
          const tc = new TransformControls(cam, canvas);
          tc.setSize(0.8);
          tc.addEventListener('dragging-changed', (ev) => { if (orbit) orbit.enabled = !ev.value; });
          // r169+ exposes getHelper(); r168 adds the controls object directly.
          scene.add(tc.getHelper ? tc.getHelper() : tc);
          builder.setTransformControls(tc);
        } catch(e) { console.warn('Gizmo init failed:', e.message); }
      }

      // Inject the part palette before UI wiring queries its buttons.
      const inner=document.getElementById('build-panel-inner');
      if (inner) inner.innerHTML = CreatureBuilder.buildPartPanelHTML();
      ldOk(r);
    } catch(e) { ldWarn(r,'Builder: '+e.message); } }

  /* 13 ── GUI */
  const simP = { gravity:-9.8, substeps:SUBS, domain:true, heatRadius:1.0 };
  if (GUI) {
    const r=ldStep('Properties GUI…');
    try { buildGUI(GUI, simP, sim, domHelper); ldOk(r); }
    catch(e) { ldWarn(r,'GUI: '+e.message); }
  }

  /* 14 ── UI events */
  { const r=ldStep('Wiring UI…');
    try { wireUI(THREE, sim, cam, tapMesh, simP, builder); ldOk(r); }
    catch(e) { ldWarn(r,'UI: '+e.message); } }

  ldOk(ldStep(''),'Running ✓');
  hideLoader();

  setTimeout(()=>{ const h=document.getElementById('hint'); if(h){h.style.opacity='0';setTimeout(()=>h.remove(),1200);} },5000);

  /* ── Render loop ──────────────────────────────────────────── */
  const fpsEl  = document.getElementById('hfps');
  const pcEl   = document.getElementById('hpc');
  const tempEl = document.getElementById('htemp');
  let _lastFpsT=0, _fc=0;

  // Resize composer when canvas resizes
  const resizeComposer = () => {
    if (!composer) return;
    const w=document.getElementById('c').clientWidth, h=document.getElementById('c').clientHeight;
    composer.setSize(w,h);
  };
  new ResizeObserver(resizeComposer).observe(document.getElementById('c'));

  let _lastGrav=null, _lastSub=null;

  function tick(t) {
    requestAnimationFrame(tick);

    /* Push parameter changes to the sim (only when they change) */
    if (simP.gravity !== _lastGrav) { sim.setGravity(simP.gravity); _lastGrav = simP.gravity; }
    const sb = Math.round(simP.substeps);
    if (sb !== _lastSub) { sim.setSubsteps(sb); _lastSub = sb; }

    /* Main-thread fallback advances the sim here; worker advances itself. */
    if (!sim.isWorker) sim.stepLocal();

    if (orbit) orbit.update();

    /* Particle renderer (always called — count 0 clears stale geometry) */
    const cv = document.getElementById('c');
    if (partRenderer && sim.snapshot) {
      try { partRenderer.update(sim.count, sim.snapshot, cv.clientWidth, cv.clientHeight); }
      catch(_){}
    }

    /* Render */
    if (composer) { try { composer.render(); } catch(_){ renderer.render(scene, cam); } }
    else renderer.render(scene, cam);

    /* HUD (throttled) */
    _fc++;
    if (t - _lastFpsT > 700) {
      fpsEl.textContent = Math.round(_fc/(t-_lastFpsT)*1000);
      pcEl.textContent  = sim.count.toLocaleString();
      if (tempEl) {
        const avgT = sim.avgTemp();
        tempEl.textContent = avgT !== null ? (avgT-273).toFixed(0)+'°C' : '--';
      }
      _fc=0; _lastFpsT=t;
    }
  }
  requestAnimationFrame(tick);
}

/* ══════════════════════════════════════════════════════════════
   Scene builder
   ══════════════════════════════════════════════════════════════ */
async function buildScene(THREE, OrbitControls, Sky, renderer) {
  const r=ldStep('Building 3D scene…');
  const canvas=document.getElementById('c');
  const DOM=48*0.25;

  const scene=new THREE.Scene();
  scene.fog=new THREE.FogExp2(0x8899bb, 0.010);

  const cam=new THREE.PerspectiveCamera(60,1,0.1,800);
  cam.position.set(DOM*.8, DOM*.55, DOM*1.1);

  function resize() {
    const w=canvas.clientWidth, h=canvas.clientHeight;
    renderer.setSize(w,h,false);
    cam.aspect=w/h; cam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  function orient() {
    const ls=window.innerWidth>window.innerHeight;
    document.body.classList.toggle('landscape',ls);
    document.body.classList.toggle('portrait',!ls);
    document.body.classList.toggle('desk', window.innerWidth>=900&&ls);
  }
  window.addEventListener('resize',()=>{orient();resize()}); orient();

  /* Lighting */
  scene.add(new THREE.AmbientLight(0x334466,0.9));
  const sun=new THREE.DirectionalLight(0xfff5dd,1.5);
  sun.position.set(25,50,15); sun.castShadow=true;
  sun.shadow.mapSize.set(1024,1024);
  sun.shadow.camera.left=sun.shadow.camera.bottom=-20;
  sun.shadow.camera.right=sun.shadow.camera.top=20;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x6688ff, 0.45);
  fill.position.set(-15, 10, -10);
  scene.add(fill);

  /* Sky or fallback */
  if (Sky) {
    try {
      const sky=new Sky(); sky.scale.setScalar(1000); scene.add(sky);
      const su=sky.material.uniforms;
      su.turbidity.value=3.5; su.rayleigh.value=1.2;
      su.mieCoefficient.value=0.004; su.mieDirectionalG.value=0.82;
      const sp=new THREE.Vector3();
      sp.setFromSphericalCoords(1,THREE.MathUtils.degToRad(72),THREE.MathUtils.degToRad(190));
      su.sunPosition.value.copy(sp);
    } catch(e) { scene.background=new THREE.Color(0x88aacc); }
  } else scene.background=new THREE.Color(0x88aacc);

  /* Ground */
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(400,400), new THREE.MeshStandardMaterial({color:0x3a6b2f,roughness:0.95}));
  ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);

  /* Domain box */
  const domBox=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(DOM,DOM,DOM));
  const domHelper=new THREE.Box3Helper(domBox, new THREE.Color(0x005577));
  scene.add(domHelper);

  /* Tap plane (invisible, used for raycast) */
  const tapMesh=new THREE.Mesh(new THREE.PlaneGeometry(DOM*8,DOM*8), new THREE.MeshBasicMaterial({visible:false,side:THREE.DoubleSide}));
  tapMesh.rotation.x=-Math.PI/2; tapMesh.position.set(DOM/2, DOM/2, DOM/2); scene.add(tapMesh);

  /* OrbitControls */
  let orbit=null;
  if (OrbitControls) {
    orbit=new OrbitControls(cam,canvas);
    orbit.target.set(DOM/2,1,DOM/2);
    orbit.enableDamping=true; orbit.dampingFactor=0.08;
    orbit.minDistance=1; orbit.maxDistance=80; orbit.maxPolarAngle=Math.PI*.88;
    orbit.update();
  }

  ldOk(r,`Scene ready (domain ${DOM} m)`);
  return { scene, cam, orbit, tapMesh, domHelper };
}

/* ══════════════════════════════════════════════════════════════
   GUI
   ══════════════════════════════════════════════════════════════ */
function buildGUI(GUI, simP, sim, domHelper) {
  const gui=new GUI({ container:document.getElementById('gui-root'), width:220, title:'Settings' });
  gui.add(simP,'gravity',-25,0,0.1).name('Gravity m/s²');
  gui.add(simP,'substeps',3,12,1).name('Substeps/frame');
  gui.add(simP,'domain').name('Domain box').onChange(v=>{domHelper.visible=v;});
  gui.add(simP,'heatRadius',0.5,5,0.1).name('Heat radius');

  const c = sim.DOMAIN/2;
  const heat = { add:()=>sim.addHeat(c,c,c, simP.heatRadius, 80),
                 rem:()=>sim.addHeat(c,c,c, simP.heatRadius,-80) };
  gui.add(heat,'add').name('🔥 Add heat (centre)');
  gui.add(heat,'rem').name('❄ Remove heat (centre)');

  const actions={
    reset(){ sim.reset(); },
    water(){ spawnRandom(sim,0); }, sand(){ spawnRandom(sim,1); },
    lava(){ spawnRandom(sim,2); }, air(){ spawnRandom(sim,8); },
  };
  gui.add(actions,'reset').name('⟳ Reset');
  const spawn=gui.addFolder('Spawn material');
  spawn.add(actions,'water').name('Water'); spawn.add(actions,'sand').name('Sand');
  spawn.add(actions,'lava').name('Lava');   spawn.add(actions,'air').name('Air');
}

function spawnRandom(sim, matId) {
  const d=sim.DOMAIN, hs=1.0;
  const cx=hs+Math.random()*(d-hs*2), cz=hs+Math.random()*(d-hs*2);
  const top=d*0.55;
  sim.spawnBox(cx-hs,top-hs*2,cz-hs, cx+hs,top,cz+hs, matId);
}

/* ══════════════════════════════════════════════════════════════
   UI wiring
   ══════════════════════════════════════════════════════════════ */
function wireUI(THREE, sim, cam, tapMesh, simP, builder) {
  const DOM=sim.DOMAIN;
  let activeMat=0, spawnSize=1.5;
  let mode='world';  // 'world' | 'build' | 'simulate'

  /* ── Mode tabs ─────────────────────────────────────────────── */
  document.querySelectorAll('.mbtn[data-mode]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mbtn[data-mode]').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      mode = b.dataset.mode;
      _switchMode(mode);
    });
  });

  function _switchMode(m) {
    const worldPanel = document.getElementById('world-panel');
    const buildPanel = document.getElementById('build-panel');
    if (worldPanel) worldPanel.style.display = (m==='world') ? '' : 'none';
    if (buildPanel) buildPanel.style.display = (m==='build') ? '' : 'none';
    if (builder) {
      if (m==='build') builder.enable();
      else             builder.disable();
    }
    // In SIMULATE mode: the physics just runs normally (creature builder
    // stays disabled but MPM keeps ticking — drop creature into world).
  }

  /* ── Material selector ─────────────────────────────────────── */
  document.querySelectorAll('.mfbtn[data-m]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mfbtn[data-m]').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      activeMat=+b.dataset.m;
      document.getElementById('hmat').textContent = MATERIALS[activeMat]?.name ?? activeMat;
    });
  });

  /* ── Creature builder controls ─────────────────────────────── */
  // Part palette
  document.querySelectorAll('.part-btn[data-part]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.part-btn').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      builder?.setActivePart(b.dataset.part);
    });
  });
  // Presets
  document.querySelectorAll('[data-preset]').forEach(b => {
    b.addEventListener('click', () => builder?.loadPreset(b.dataset.preset));
  });
  // Gizmo mode
  const btnMove = document.getElementById('btn-move');
  const btnRot  = document.getElementById('btn-rotate');
  btnMove?.addEventListener('click', () => { builder?.setGizmoMode('translate'); btnMove.classList.add('on'); btnRot?.classList.remove('on'); });
  btnRot ?.addEventListener('click', () => { builder?.setGizmoMode('rotate');    btnRot.classList.add('on'); btnMove?.classList.remove('on'); });
  // Joint type
  document.querySelectorAll('[data-joint]').forEach(b => {
    b.addEventListener('click', () => builder?.setJointType(b.dataset.joint));
  });
  // Rotate / mirror / delete / clear
  document.getElementById('btn-rotx')?.addEventListener('click', ()=>builder?.rotateSelected('x', 15));
  document.getElementById('btn-roty')?.addEventListener('click', ()=>builder?.rotateSelected('y', 15));
  document.getElementById('btn-mirror')?.addEventListener('click', ()=>builder?.toggleMirror());
  document.getElementById('btn-del')?.addEventListener('click',    ()=>builder?.deleteSelected());
  document.getElementById('btn-clear')?.addEventListener('click',  ()=>builder?.clearAll());
  document.getElementById('btn-save')?.addEventListener('click',   ()=>builder?.save());
  document.getElementById('btn-load')?.addEventListener('click',   ()=>{ if(!builder?.load()) alert('No saved creature.'); });
  // Chain length
  const chainEl = document.getElementById('chain-len');
  chainEl?.addEventListener('input', e => {
    const v=+e.target.value;
    document.getElementById('chain-val').textContent = v;
    builder?.setChainLength(v);
  });
  // Scale (absolute)
  const scaleSlider = document.getElementById('part-scale');
  scaleSlider?.addEventListener('input', e => {
    const v=+e.target.value;
    document.getElementById('scale-val').textContent = v.toFixed(1);
    builder?.scaleSelected(v);
  });

  /* Selected-part info readout */
  document.getElementById('c').addEventListener('creature-change', (e) => {
    const info = document.getElementById('sel-info');
    if (!info) return;
    const s = e.detail.selected;
    info.textContent = s
      ? `${s.type} · joint: ${s.joint} · scale ${s.scale.toFixed(1)}×  (${e.detail.parts} parts)`
      : `None selected  (${e.detail.parts} parts)`;
  });

  /* ── Panel toggles ─────────────────────────────────────────── */
  document.getElementById('fab-panel')?.addEventListener('click',()=>document.body.classList.toggle('lp-open'));
  document.getElementById('btn-rp')?.addEventListener('click',   ()=>document.body.classList.toggle('rp-open'));

  /* ── Spawn size ────────────────────────────────────────────── */
  const szEl=document.getElementById('spawn-size');
  if (szEl) szEl.addEventListener('input',e=>{ spawnSize=+e.target.value; document.getElementById('size-label').textContent=spawnSize; });

  /* ── FAB spawn ─────────────────────────────────────────────── */
  document.getElementById('fab-spawn')?.addEventListener('click',()=>spawnRandom(sim,activeMat));

  /* ── Heat brush (hold H + tap) ─────────────────────────────── */
  let heatMode=false, heatDir=1;
  document.addEventListener('keydown',e=>{ if(e.key==='h'||e.key==='H'){heatMode=true;heatDir=e.shiftKey?-1:1;} });
  document.addEventListener('keyup',  e=>{ if(e.key==='h'||e.key==='H') heatMode=false; });

  /* ── Tap-to-pour / heat (canvas) ───────────────────────────── */
  const ray=new THREE.Raycaster(), rv2=new THREE.Vector2();
  let ptrDn=null;
  const canvas=document.getElementById('c');

  canvas.addEventListener('pointerdown',e=>{ ptrDn=[e.clientX,e.clientY]; });
  canvas.addEventListener('pointerup',e=>{
    if (!ptrDn||mode!=='world') { ptrDn=null; return; }
    const ddx=e.clientX-ptrDn[0], ddy=e.clientY-ptrDn[1];
    if (Math.sqrt(ddx*ddx+ddy*ddy) < 12) {
      const rect=canvas.getBoundingClientRect();
      rv2.set(((e.clientX-rect.left)/rect.width)*2-1, -((e.clientY-rect.top)/rect.height)*2+1);
      ray.setFromCamera(rv2,cam);
      const hits=ray.intersectObject(tapMesh);
      if (hits.length) {
        const pt=hits[0].point;
        if (heatMode) {
          sim.addHeat(pt.x, pt.y, pt.z, simP.heatRadius, 120*heatDir);
        } else {
          const hs=spawnSize/2;
          const cx=Math.max(hs+.5,Math.min(DOM-hs-.5,pt.x));
          const cz=Math.max(hs+.5,Math.min(DOM-hs-.5,pt.z));
          const cy=Math.min(DOM-hs-.5, pt.y+spawnSize*1.5);
          sim.spawnBox(cx-hs,cy-spawnSize,cz-hs, cx+hs,cy,cz+hs, activeMat);
        }
      }
    }
    ptrDn=null;
  });

  /* Initial mode */
  _switchMode('world');
}

/* ── Entry ────────────────────────────────────────────────────── */
main().catch(e=>{
  console.error('Fatal:', e.message, e.stack);
  const r=ldStep('Fatal error');
  ldFail(r,String(e));
  if (window.ErrPanel) window.ErrPanel.open();
});
