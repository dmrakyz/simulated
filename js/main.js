/**
 * FluidCreature — Main Entry Point
 *
 * Modes:
 *   WORLD    — free-camera, tap/click to pour materials, heat interactions
 *   BUILD    — creature creator (place body parts, joints, muscles)
 *   SIMULATE — drop creature into world and run physics
 */

import { MPM, MATERIALS, K } from './mpm.js';
import { ParticleRenderer }  from './rendering/particle-renderer.js';
import { CreatureBuilder }   from './creature/builder.js';

/* ── Device tier ──────────────────────────────────────────────── */
const _cores  = navigator.hardwareConcurrency || 4;
const _isDesk = window.matchMedia('(pointer:fine)').matches && _cores >= 8;
const MAXP    = _isDesk ? 30000 : 13000;
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
  let THREE, OrbitControls, Sky, GUI, EffectComposer, UnrealBloomPass, RenderPass;

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

  /* 8 ── Bloom composer */
  let composer = null;
  if (EffectComposer && RenderPass && UnrealBloomPass) {
    try {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, cam));
      const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.35, 0.85);
      composer.addPass(bloom);
    } catch(e) { composer=null; }
  }

  /* 9 ── MPM */
  let mpm;
  { const r=ldStep('MPM engine…');
    try {
      mpm=new MPM({ gridN:48, dx:0.25, maxParticles:MAXP, substeps:SUBS });
      ldOk(r,`Grid ${mpm.N}³ · domain ${mpm.DOMAIN.toFixed(1)} m · max ${mpm.MAX}`);
    } catch(e) { ldFail(r,'MPM failed: '+e.message); return; } }

  /* 10 ── Particle renderer */
  let partRenderer;
  { const r=ldStep('Particle renderer…');
    try { partRenderer=new ParticleRenderer(THREE, scene, MAXP, renderer); ldOk(r); }
    catch(e) { ldWarn(r,'Particle renderer failed: '+e.message); } }

  /* 11 ── Demo scene */
  { const r=ldStep('Spawning demo…');
    try {
      const d=mpm.DOMAIN;
      mpm.spawnBox(d*.42, d*.45, d*.42, d*.58, d*.62, d*.58, 7);   // ice block
      mpm.spawnBox(d*.22, d*.04, d*.22, d*.78, d*.20, d*.78, 0);   // water
      ldOk(r, `${mpm.nP} particles`);
    } catch(e) { ldWarn(r,'Spawn: '+e.message); }
    document.getElementById('hpc').textContent = mpm.nP; }

  /* 12 ── Creature builder */
  let builder;
  { const r=ldStep('Creature builder…');
    try {
      const canvas=document.getElementById('c');
      builder=new CreatureBuilder(THREE, scene, cam, renderer, canvas);
      ldOk(r);
    } catch(e) { ldWarn(r,'Builder: '+e.message); } }

  /* 13 ── GUI */
  const simP = { gravity:-9.8, substeps:SUBS, domain:true, heatRadius:1.0 };
  if (GUI) {
    const r=ldStep('Properties GUI…');
    try { buildGUI(GUI, simP, mpm, domHelper); ldOk(r); }
    catch(e) { ldWarn(r,'GUI: '+e.message); }
  }

  /* 14 ── UI events */
  { const r=ldStep('Wiring UI…');
    try { wireUI(THREE, mpm, cam, tapMesh, simP, builder); ldOk(r); }
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

  function tick(t) {
    requestAnimationFrame(tick);

    mpm.gravity = simP.gravity;
    mpm.sub     = Math.round(simP.substeps);

    try { mpm.tick(); } catch(e) { console.error('MPM tick:', e.message); }
    if (orbit) orbit.update();

    /* Particle renderer update */
    const cv = document.getElementById('c');
    if (partRenderer) {
      try { partRenderer.update(mpm, cv.clientWidth, cv.clientHeight); }
      catch(_){}
    }

    /* Render */
    if (composer) { try { composer.render(); } catch(_){ renderer.render(scene, cam); } }
    else renderer.render(scene, cam);

    /* HUD updates (throttled) */
    _fc++;
    if (t - _lastFpsT > 700) {
      fpsEl.textContent = Math.round(_fc/(t-_lastFpsT)*1000);
      pcEl.textContent  = mpm.nP;
      // Show avg temperature of selected material
      if (tempEl) {
        const avgT = sampleAvgTemp(mpm);
        tempEl.textContent = avgT !== null ? (avgT-273).toFixed(0)+'°C' : '--';
      }
      _fc=0; _lastFpsT=t;
    }
  }
  requestAnimationFrame(tick);
}

function sampleAvgTemp(mpm) {
  if (!mpm.nP) return null;
  let sum=0, count=0;
  const step = Math.max(1, Math.floor(mpm.nP/200));
  for (let p=0; p<mpm.nP; p+=step) { sum+=mpm.pT[p]; count++; }
  return count ? sum/count : null;
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
  scene.add(Object.assign(new THREE.DirectionalLight(0x6688ff,0.45), { position: new THREE.Vector3(-15,10,-10) }));

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
function buildGUI(GUI, simP, mpm, domHelper) {
  const gui=new GUI({ container:document.getElementById('gui-root'), width:220, title:'Settings' });
  gui.add(simP,'gravity',-25,0,0.1).name('Gravity m/s²');
  gui.add(simP,'substeps',3,12,1).name('Substeps/frame');
  gui.add(simP,'domain').name('Domain box').onChange(v=>{domHelper.visible=v;});
  gui.add(simP,'heatRadius',0.5,5,0.1).name('Heat radius');

  const heat = { add:()=>mpm.addHeat(mpm.DOMAIN/2, mpm.DOMAIN/2, mpm.DOMAIN/2, simP.heatRadius, 80),
                 rem:()=>mpm.addHeat(mpm.DOMAIN/2, mpm.DOMAIN/2, mpm.DOMAIN/2, simP.heatRadius,-80) };
  gui.add(heat,'add').name('🔥 Add heat (centre)');
  gui.add(heat,'rem').name('❄ Remove heat (centre)');

  const actions={
    reset(){ mpm.reset(); document.getElementById('hpc').textContent=0; },
    water(){ spawnRandom(mpm,0); }, sand(){ spawnRandom(mpm,1); },
    lava(){ spawnRandom(mpm,2); }, air(){ spawnRandom(mpm,8); },
  };
  gui.add(actions,'reset').name('⟳ Reset');
  const spawn=gui.addFolder('Spawn material');
  spawn.add(actions,'water').name('Water'); spawn.add(actions,'sand').name('Sand');
  spawn.add(actions,'lava').name('Lava');   spawn.add(actions,'air').name('Air');
}

function spawnRandom(mpm, matId) {
  const d=mpm.DOMAIN, hs=1.0;
  const cx=hs+Math.random()*(d-hs*2), cz=hs+Math.random()*(d-hs*2);
  const top=d*0.55;
  mpm.spawnBox(cx-hs,top-hs*2,cz-hs, cx+hs,top,cz+hs, matId);
  document.getElementById('hpc').textContent=mpm.nP;
}

/* ══════════════════════════════════════════════════════════════
   UI wiring
   ══════════════════════════════════════════════════════════════ */
function wireUI(THREE, mpm, cam, tapMesh, simP, builder) {
  const DOM=mpm.DOMAIN;
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

  /* ── Creature builder part buttons ─────────────────────────── */
  document.querySelectorAll('.part-btn[data-part]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.part-btn').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      if (builder) builder.setActivePart(b.dataset.part);
    });
  });
  document.getElementById('btn-mirror')?.addEventListener('click', ()=>builder?.toggleMirror());
  document.getElementById('btn-del')?.addEventListener('click',    ()=>builder?.deleteSelected());
  document.getElementById('btn-save')?.addEventListener('click',   ()=>builder?.save());
  document.getElementById('btn-load')?.addEventListener('click',   ()=>{ if(builder?.load()) alert('Creature loaded!'); else alert('No saved creature.'); });

  const scaleSlider = document.getElementById('part-scale');
  if (scaleSlider) {
    scaleSlider.addEventListener('input', e => {
      const v=+e.target.value;
      document.getElementById('scale-val').textContent=v.toFixed(1);
      if (builder) builder.scaleSelected(v / (parseFloat(scaleSlider.dataset.prev??1)));
      scaleSlider.dataset.prev = v;
    });
  }

  /* ── Panel toggles ─────────────────────────────────────────── */
  document.getElementById('fab-panel')?.addEventListener('click',()=>document.body.classList.toggle('lp-open'));
  document.getElementById('btn-rp')?.addEventListener('click',   ()=>document.body.classList.toggle('rp-open'));

  /* ── Spawn size ────────────────────────────────────────────── */
  const szEl=document.getElementById('spawn-size');
  if (szEl) szEl.addEventListener('input',e=>{ spawnSize=+e.target.value; document.getElementById('size-label').textContent=spawnSize; });

  /* ── FAB spawn ─────────────────────────────────────────────── */
  document.getElementById('fab-spawn')?.addEventListener('click',()=>spawnRandom(mpm,activeMat));

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
          mpm.addHeat(pt.x, pt.y, pt.z, simP.heatRadius, 120*heatDir);
        } else {
          const hs=spawnSize/2;
          const cx=Math.max(hs+.5,Math.min(DOM-hs-.5,pt.x));
          const cz=Math.max(hs+.5,Math.min(DOM-hs-.5,pt.z));
          const cy=Math.min(DOM-hs-.5, pt.y+spawnSize*1.5);
          mpm.spawnBox(cx-hs,cy-spawnSize,cz-hs, cx+hs,cy,cz+hs, activeMat);
          document.getElementById('hpc').textContent=mpm.nP;
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
