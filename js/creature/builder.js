/**
 * Creature Builder — full editor.
 *
 *   CreatureNode    one body part (geometry mesh + joint to parent)
 *   CreatureGraph   tree of nodes (serialises to JSON / localStorage)
 *   CreatureBuilder interactive editor:
 *                     • click empty ground to place the active part
 *                     • click a part to select it
 *                     • TransformControls gizmo to move/rotate (optional addon)
 *                     • chain placement for spine / tail / tentacle
 *                     • mirror, scale, rotate, delete
 *                     • joint type per part
 *                     • preset creatures (snake / quadruped / bird)
 *                     • save / load
 */

import { PART_TYPES, PART_ORDER, JOINT_TYPES } from './parts.js';

let _idSeq = 0;
const uid = () => `n${++_idSeq}`;

/* ── Node ───────────────────────────────────────────────────────── */
export class CreatureNode {
  constructor(partType, position, parentId=null) {
    this.id        = uid();
    this.type      = partType;
    this.parentId  = parentId;
    this.childIds  = [];
    this.position  = position.clone();
    this.rotation  = { x:0, y:0, z:0 };
    this.scale     = 1.0;
    this.mirror    = false;
    this.jointType = PART_TYPES[partType]?.defaultJoint ?? 'BALL';
    this.mesh      = null;
    this.mirrorMesh= null;
  }
}

/* ── Graph ──────────────────────────────────────────────────────── */
export class CreatureGraph {
  constructor() { this.nodes = new Map(); this.rootId = null; }

  addNode(partType, position, parentId=null) {
    const n = new CreatureNode(partType, position, parentId);
    this.nodes.set(n.id, n);
    if (parentId && this.nodes.has(parentId)) this.nodes.get(parentId).childIds.push(n.id);
    if (!this.rootId) this.rootId = n.id;
    return n;
  }

  removeNode(id) {
    const n = this.nodes.get(id); if (!n) return;
    [...n.childIds].forEach(c => this.removeNode(c));
    if (n.parentId) {
      const p = this.nodes.get(n.parentId);
      if (p) p.childIds = p.childIds.filter(c => c !== id);
    }
    if (this.rootId === id) this.rootId = null;
    this.nodes.delete(id);
  }

  toJSON() {
    return { rootId:this.rootId, nodes:[...this.nodes.values()].map(n => ({
      id:n.id, type:n.type, parentId:n.parentId, childIds:[...n.childIds],
      position:{x:n.position.x,y:n.position.y,z:n.position.z},
      rotation:n.rotation, scale:n.scale, mirror:n.mirror, jointType:n.jointType,
    }))};
  }

  static fromJSON(THREE, json) {
    const g = new CreatureGraph();
    g.rootId = json.rootId;
    for (const nd of json.nodes) {
      const node = new CreatureNode(nd.type, new THREE.Vector3(nd.position.x,nd.position.y,nd.position.z), nd.parentId);
      Object.assign(node, { id:nd.id, childIds:nd.childIds, rotation:nd.rotation,
        scale:nd.scale, mirror:nd.mirror, jointType:nd.jointType });
      g.nodes.set(node.id, node);
      const num = parseInt(nd.id.slice(1)); if (num > _idSeq) _idSeq = num;
    }
    return g;
  }
}

/* ── Builder ────────────────────────────────────────────────────── */
export class CreatureBuilder {
  constructor(THREE, scene, camera, renderer, dom) {
    this.THREE = THREE; this.scene = scene; this.camera = camera;
    this.renderer = renderer; this.dom = dom;

    this.graph      = new CreatureGraph();
    this.selectedId = null;
    this.activePart = 'TORSO';
    this.active     = false;
    this.chainLen   = 8;
    this.tc         = null;   // TransformControls (set by main, optional)

    this._meshGroup = new THREE.Group();  scene.add(this._meshGroup);
    this._jointGroup= new THREE.Group();  scene.add(this._jointGroup);

    this._ray   = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();
    this._plane = new THREE.Mesh(
      new THREE.PlaneGeometry(120,120),
      new THREE.MeshBasicMaterial({ visible:false, side:THREE.DoubleSide }));
    this._plane.rotation.x = -Math.PI/2;
    scene.add(this._plane);

    this._materials = this._buildMaterials();
    this._selMat = new THREE.MeshStandardMaterial({ color:0x00ff99, emissive:0x004422, roughness:0.4 });
    this._jointMat = new THREE.LineBasicMaterial({ color:0xffdd33, transparent:true, opacity:0.6 });

    this._downXY = null;
    this._onDown = e => { if (this.active) this._downXY = [e.clientX, e.clientY]; };
    this._onUp   = this._onUp.bind(this);
  }

  /* TransformControls injected by main (so it can wire orbit toggling). */
  setTransformControls(tc) {
    this.tc = tc;
    if (!tc) return;
    tc.addEventListener('objectChange', () => this._syncFromGizmo());
  }

  _buildMaterials() {
    const T = this.THREE;
    const mk = (c, r=0.6, m=0) => new T.MeshStandardMaterial({ color:c, roughness:r, metalness:m });
    return {
      TORSO:mk(0xff9988,0.75), HEAD:mk(0xffbbaa,0.7), BONE:mk(0xf0e8c8,0.6),
      SPINE:mk(0xe8ddb8,0.6), LIMB:mk(0xffaa99,0.7), TAIL:mk(0xeeaa88,0.7),
      TENTACLE:mk(0xcc7766,0.8), WING:mk(0xddaa99,0.55,0.1), FIN:mk(0x88bbcc,0.5,0.05),
      CLAW:mk(0xbbaa99,0.4,0.2), HORN:mk(0xeeeecc,0.35), EYE:mk(0x111111,0.15,0.4),
    };
  }

  /* ── Geometry ──────────────────────────────────────────────── */
  _geometry(type, scale=1) {
    const T = this.THREE, def = PART_TYPES[type];
    if (!def) return new T.SphereGeometry(0.2*scale);
    const g = def.geometry, s = scale;
    switch (g.type) {
      case 'sphere':  return new T.SphereGeometry(g.radius*s, 16, 12);
      case 'capsule': return new T.CapsuleGeometry(g.radius*s, g.length*s, 6, 12);
      case 'box':     return new T.BoxGeometry(g.w*s, g.h*s, g.d*s);
      case 'cone':    return new T.ConeGeometry(g.radius*s, g.height*s, 12);
      case 'wing': {
        const shape = new T.Shape();
        const span=g.span*s, chord=g.chord*s, sweep=g.sweep*s;
        shape.moveTo(0,0); shape.lineTo(sweep,span);
        shape.lineTo(sweep+chord*0.5,span); shape.lineTo(chord,0); shape.closePath();
        return new T.ExtrudeGeometry(shape, { depth:0.02*s, bevelEnabled:false });
      }
      case 'fin': {
        const shape = new T.Shape();
        shape.moveTo(0,0); shape.lineTo(g.width*s, g.height*s*0.4);
        shape.lineTo(g.width*s*0.5, g.height*s); shape.closePath();
        return new T.ExtrudeGeometry(shape, { depth:0.015*s, bevelEnabled:false });
      }
      default: return new T.SphereGeometry(0.2*s);
    }
  }

  _buildMesh(node) {
    const T = this.THREE;
    const mesh = new T.Mesh(this._geometry(node.type, node.scale),
      (this._materials[node.type] ?? this._materials.BONE).clone());
    mesh.position.copy(node.position);
    mesh.rotation.set(node.rotation.x, node.rotation.y, node.rotation.z);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.nodeId = node.id;
    return mesh;
  }

  _rebuildMesh(node) {
    if (node.mesh)       { this._meshGroup.remove(node.mesh); node.mesh.geometry.dispose(); }
    if (node.mirrorMesh) { this._meshGroup.remove(node.mirrorMesh); node.mirrorMesh.geometry.dispose(); }
    node.mesh = this._buildMesh(node);
    this._meshGroup.add(node.mesh);
    if (node.mirror) {
      node.mirrorMesh = node.mesh.clone();
      node.mirrorMesh.material = node.mesh.material.clone();
      node.mirrorMesh.position.x = -node.position.x;
      node.mirrorMesh.scale.x *= -1;
      node.mirrorMesh.userData.nodeId = node.id + '_mirror';
      this._meshGroup.add(node.mirrorMesh);
    }
  }

  _drawJoints() {
    const T = this.THREE;
    while (this._jointGroup.children.length) {
      const c = this._jointGroup.children.pop();
      c.geometry.dispose(); this._jointGroup.remove(c);
    }
    for (const [,node] of this.graph.nodes) {
      if (!node.parentId || !node.mesh) continue;
      const parent = this.graph.nodes.get(node.parentId);
      if (!parent?.mesh) continue;
      const geo = new T.BufferGeometry().setFromPoints([
        parent.mesh.position.clone(), node.mesh.position.clone()]);
      this._jointGroup.add(new T.Line(geo, this._jointMat));
    }
  }

  /* ── Mode toggling ─────────────────────────────────────────── */
  enable() {
    this.active = true;
    this._meshGroup.visible = true;
    this._jointGroup.visible = true;
    this.dom.addEventListener('pointerdown', this._onDown);
    this.dom.addEventListener('pointerup', this._onUp);
  }
  disable() {
    this.active = false;
    this._jointGroup.visible = false;
    if (this.tc) this.tc.detach();
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('pointerup', this._onUp);
  }

  setActivePart(type) { this.activePart = type; }
  setChainLength(n)   { this.chainLen = Math.max(1, Math.min(40, n|0)); }
  setGizmoMode(m)     { if (this.tc) this.tc.setMode(m); }
  setJointType(t) {
    if (!this.selectedId) return;
    const n = this.graph.nodes.get(this.selectedId);
    if (n) { n.jointType = t; this._emit(); }
  }

  /* ── Picking / placement ───────────────────────────────────── */
  _ndc(e) {
    const r = this.dom.getBoundingClientRect();
    this._mouse.set(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1);
  }
  _pickNode(e) {
    this._ndc(e); this._ray.setFromCamera(this._mouse, this.camera);
    const meshes = [...this.graph.nodes.values()].filter(n=>n.mesh).map(n=>n.mesh);
    const hits = this._ray.intersectObjects(meshes);
    return hits.length ? hits[0].object.userData.nodeId : null;
  }
  _planePos(e) {
    this._ndc(e); this._ray.setFromCamera(this._mouse, this.camera);
    const hits = this._ray.intersectObject(this._plane);
    return hits.length ? hits[0].point : null;
  }

  _onUp(e) {
    if (!this.active || !this._downXY) { this._downXY = null; return; }
    // Ignore if the gizmo is being dragged.
    if (this.tc && this.tc.dragging) { this._downXY = null; return; }
    const dx = e.clientX-this._downXY[0], dy = e.clientY-this._downXY[1];
    this._downXY = null;
    if (Math.hypot(dx, dy) >= 8) return;   // was a camera drag

    const hit = this._pickNode(e);
    if (hit) { this._select(hit); return; }

    const pos = this._planePos(e);
    if (!pos) return;
    pos.y = Math.max(0.2, pos.y);

    const def = PART_TYPES[this.activePart];
    if (def?.repeat) this._placeChain(this.activePart, pos);
    else {
      const node = this.graph.addNode(this.activePart, pos, this.selectedId);
      this._rebuildMesh(node);
      this._drawJoints();
      this._select(node.id);
    }
    this._emit();
  }

  /* Place a chain of segments extending in +X from the click. */
  _placeChain(type, start) {
    const T = this.THREE;
    const def = PART_TYPES[type];
    const segLen = (def.geometry.length ?? 0.35);
    let parentId = this.selectedId;
    let last = null;
    for (let i=0; i<this.chainLen; i++) {
      const pos = new T.Vector3(start.x + i*segLen, start.y, start.z);
      const node = this.graph.addNode(type, pos, parentId);
      if (def.taper) node.scale = 1 - (i / this.chainLen) * 0.6;
      this._rebuildMesh(node);
      parentId = node.id;
      last = node;
    }
    this._drawJoints();
    if (last) this._select(last.id);
  }

  /* ── Selection + gizmo ─────────────────────────────────────── */
  _select(id) {
    if (id && id.endsWith('_mirror')) id = id.slice(0, -7);
    if (id && !this.graph.nodes.has(id)) id = null;

    if (this.selectedId) {
      const prev = this.graph.nodes.get(this.selectedId);
      if (prev?.mesh) prev.mesh.material = (this._materials[prev.type] ?? this._materials.BONE).clone();
    }
    this.selectedId = id;
    if (this.tc) this.tc.detach();

    if (id) {
      const n = this.graph.nodes.get(id);
      if (n?.mesh) {
        n.mesh.material = this._selMat.clone();
        if (this.tc) this.tc.attach(n.mesh);
        const sl = document.getElementById('part-scale');
        if (sl) { sl.value = n.scale; const l = document.getElementById('scale-val'); if (l) l.textContent = n.scale.toFixed(1); }
      }
    }
    this._emit();
  }

  /* Pull transform from the gizmo back into the node + mirror. */
  _syncFromGizmo() {
    if (!this.selectedId) return;
    const n = this.graph.nodes.get(this.selectedId);
    if (!n?.mesh) return;
    n.position.copy(n.mesh.position);
    n.rotation = { x:n.mesh.rotation.x, y:n.mesh.rotation.y, z:n.mesh.rotation.z };
    if (n.mirrorMesh) {
      n.mirrorMesh.position.set(-n.position.x, n.position.y, n.position.z);
      n.mirrorMesh.rotation.copy(n.mesh.rotation);
    }
    this._drawJoints();
  }

  /* ── Edits ─────────────────────────────────────────────────── */
  rotateSelected(axis, deg) {
    if (!this.selectedId) return;
    const n = this.graph.nodes.get(this.selectedId); if (!n) return;
    n.rotation[axis] += deg * Math.PI/180;
    if (n.mesh) n.mesh.rotation.set(n.rotation.x, n.rotation.y, n.rotation.z);
    this._syncFromGizmo(); this._emit();
  }
  scaleSelected(absScale) {
    if (!this.selectedId) return;
    const n = this.graph.nodes.get(this.selectedId); if (!n) return;
    n.scale = Math.max(0.1, Math.min(10, absScale));
    this._rebuildMesh(n);
    if (this.tc && n.mesh) this.tc.attach(n.mesh);
    this._drawJoints(); this._emit();
  }
  toggleMirror() {
    if (!this.selectedId) return;
    const n = this.graph.nodes.get(this.selectedId); if (!n) return;
    n.mirror = !n.mirror; this._rebuildMesh(n);
    if (this.tc && n.mesh) this.tc.attach(n.mesh);
    this._emit();
  }
  deleteSelected() {
    if (!this.selectedId) return;
    if (this.tc) this.tc.detach();
    const collect = (id, acc) => { const nn=this.graph.nodes.get(id); if(!nn) return; acc.push(nn); nn.childIds.forEach(c=>collect(c,acc)); };
    const doomed = []; collect(this.selectedId, doomed);
    for (const n of doomed) {
      if (n.mesh) this._meshGroup.remove(n.mesh);
      if (n.mirrorMesh) this._meshGroup.remove(n.mirrorMesh);
    }
    this.graph.removeNode(this.selectedId);
    this.selectedId = null;
    this._drawJoints(); this._emit();
  }

  clearAll() {
    if (this.tc) this.tc.detach();
    for (const [,n] of this.graph.nodes) {
      if (n.mesh) this._meshGroup.remove(n.mesh);
      if (n.mirrorMesh) this._meshGroup.remove(n.mirrorMesh);
    }
    this.graph = new CreatureGraph();
    this.selectedId = null;
    this._drawJoints();
  }

  /* ── Presets ───────────────────────────────────────────────── */
  loadPreset(name) {
    const T = this.THREE;
    this.clearAll();
    const V = (x,y,z) => new T.Vector3(x,y,z);
    const add = (type, pos, parent) => this.graph.addNode(type, pos, parent);

    if (name === 'snake') {
      const head = add('HEAD', V(0,1,0), null); head.scale = 0.7;
      let prev = head.id;
      for (let i=0; i<18; i++) {
        const n = add('SPINE', V(-0.32*(i+1), 1, 0), prev);
        n.scale = 1 - i*0.025; prev = n.id;
      }
    } else if (name === 'quadruped') {
      const torso = add('TORSO', V(0,1.4,0), null); torso.scale = 1.4;
      add('HEAD', V(0.9,1.7,0), torso.id);
      // 4 legs (upper + lower)
      const legXZ = [[0.6,0.5],[0.6,-0.5],[-0.6,0.5],[-0.6,-0.5]];
      for (const [lx,lz] of legXZ) {
        const up = add('LIMB', V(lx,0.9,lz), torso.id);
        add('LIMB', V(lx,0.35,lz), up.id);
      }
      // tail chain
      let prev = torso.id;
      for (let i=0;i<6;i++){ const n=add('TAIL', V(-0.7-0.3*i,1.4,0), prev); n.scale=1-i*0.12; prev=n.id; }
    } else if (name === 'bird') {
      const torso = add('TORSO', V(0,1.8,0), null);
      add('HEAD', V(0.5,2.3,0), torso.id);
      const w1 = add('WING', V(0.1,2.0,0.4), torso.id);  w1.rotation={x:0,y:0,z:0};
      const w2 = add('WING', V(0.1,2.0,-0.4), torso.id); w2.mirror=true;
      add('LIMB', V(0,1.2,0.2), torso.id);
      add('LIMB', V(0,1.2,-0.2), torso.id);
      let prev=torso.id; for(let i=0;i<4;i++){ const n=add('TAIL',V(-0.5-0.3*i,1.8,0),prev); n.scale=1-i*0.15; prev=n.id; }
    }

    for (const [,n] of this.graph.nodes) this._rebuildMesh(n);
    this._drawJoints();
    this._emit();
  }

  /* ── Persistence ───────────────────────────────────────────── */
  save(name='creature') {
    localStorage.setItem('fc_creature_'+name, JSON.stringify(this.graph.toJSON()));
    console.log('[Creature] saved', name, this.graph.nodes.size, 'parts');
  }
  load(name='creature') {
    const raw = localStorage.getItem('fc_creature_'+name);
    if (!raw) return false;
    this.clearAll();
    this.graph = CreatureGraph.fromJSON(this.THREE, JSON.parse(raw));
    for (const [,n] of this.graph.nodes) this._rebuildMesh(n);
    this._drawJoints(); this._emit();
    console.log('[Creature] loaded', name, this.graph.nodes.size, 'parts');
    return true;
  }

  _emit() {
    const n = this.selectedId ? this.graph.nodes.get(this.selectedId) : null;
    this.dom.dispatchEvent(new CustomEvent('creature-change', {
      detail: { parts: this.graph.nodes.size, selected: n ? { type:n.type, joint:n.jointType, scale:n.scale } : null }
    }));
  }

  /* ── Panel HTML ────────────────────────────────────────────── */
  static buildPartPanelHTML() {
    let html = '<div class="ptitle">Presets</div><div class="cbtn-row">';
    html += `<button class="mbtn" data-preset="snake">🐍 Snake</button>`;
    html += `<button class="mbtn" data-preset="quadruped">🐕 Quad</button>`;
    html += `<button class="mbtn" data-preset="bird">🦅 Bird</button>`;
    html += '</div>';

    html += '<div class="ptitle" style="margin-top:12px">Body Parts</div>';
    for (const key of PART_ORDER) {
      const d = PART_TYPES[key];
      html += `<button class="mfbtn part-btn" data-part="${key}" title="${d.desc}">
        <span style="width:16px;display:inline-block;text-align:center">${d.icon}</span> ${d.label}</button>`;
    }

    html += `<div class="ptitle" style="margin-top:12px">Chain Length</div>
      <input type="range" id="chain-len" min="2" max="30" step="1" value="8">
      <div style="font-size:10px;color:rgba(255,255,255,.35);margin-top:3px">
        <span id="chain-val">8</span> segments (spine/tail/tentacle)</div>`;

    html += `<div class="ptitle" style="margin-top:12px">Gizmo</div><div class="cbtn-row">
        <button class="mbtn on" id="btn-move">✛ Move</button>
        <button class="mbtn" id="btn-rotate">⟳ Rotate</button></div>`;

    html += `<div class="ptitle" style="margin-top:12px">Selected Part</div>
      <div id="sel-info" style="font-size:10px;color:rgba(255,255,255,.4);margin-bottom:6px">None selected</div>
      <div class="cbtn-row">
        <button class="mbtn" data-joint="BALL">● Ball</button>
        <button class="mbtn" data-joint="HINGE">⊟ Hinge</button>
        <button class="mbtn" data-joint="FIXED">✕ Weld</button>
      </div>
      <div class="cbtn-row" style="margin-top:6px">
        <button class="mbtn" id="btn-rotx">⟲ X</button>
        <button class="mbtn" id="btn-roty">⟲ Y</button>
        <button class="mbtn" id="btn-mirror">⇔ Mirror</button>
        <button class="mbtn" id="btn-del">✕ Delete</button>
      </div>
      <div class="ptitle" style="margin-top:10px">Scale</div>
      <input type="range" id="part-scale" min="0.2" max="5" step="0.1" value="1">
      <div style="font-size:10px;color:rgba(255,255,255,.35);margin-top:3px">Scale: <span id="scale-val">1.0</span>×</div>`;

    html += `<div class="ptitle" style="margin-top:12px">Creature</div><div class="cbtn-row">
        <button class="mbtn" id="btn-save">💾 Save</button>
        <button class="mbtn" id="btn-load">📂 Load</button>
        <button class="mbtn" id="btn-clear">🗑 Clear</button></div>`;
    return html;
  }
}
