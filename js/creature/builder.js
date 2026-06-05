/**
 * CreatureBuilder — BUILD-mode editor.
 *
 * Lets the user assemble a creature by placing body parts in 3D:
 *   • pick a part in the palette, tap the build platform to place it
 *   • tap an existing part to select it (gizmo attaches for move / rotate)
 *   • chain parts (spine / tail / tentacle) lay down a tapered series
 *   • mirror modifier drops a symmetric twin across the body centre-line
 *   • presets build a whole creature graph (snake / quadruped / bird)
 *   • save / load to localStorage
 *
 * Parts are plain Three.js meshes (or Groups for chains). Nothing here touches
 * the physics engine — SIMULATE mode is where a creature would later drop into
 * the world; for now BUILD is a self-contained 3D editor.
 */

import { PART_TYPES, PART_ORDER, JOINT_TYPES } from './parts.js';

let _uid = 0;

export class CreatureBuilder {
  constructor(THREE, scene, cam, renderer, canvas) {
    this.THREE    = THREE;
    this.scene    = scene;
    this.cam      = cam;
    this.renderer = renderer;
    this.canvas   = canvas;

    this.DOMAIN  = 48 * 0.25;            // matches the sim domain (12 m)
    this.BUILD_Y = this.DOMAIN * 0.34;   // platform height parts spawn on

    /* Root group so the whole creature can be hidden in WORLD/SIMULATE mode. */
    this.root = new THREE.Group();
    this.root.visible = false;
    scene.add(this.root);

    this.nodes    = new Map();   // id → { id, type, obj, joint, scale, mirrorOf }
    this.obj2node = new Map();   // top-level Object3D → node
    this.selected = null;
    this.tc       = null;

    this.activePart = 'TORSO';
    this.jointType  = 'ball';
    this.chainLen   = 6;
    this.mirror     = false;
    this.enabled    = false;

    /* Invisible horizontal platform for placement raycasts. */
    this._plane = new THREE.Mesh(
      new THREE.PlaneGeometry(this.DOMAIN * 4, this.DOMAIN * 4),
      new THREE.MeshBasicMaterial({ visible:false, side:THREE.DoubleSide })
    );
    this._plane.rotation.x = -Math.PI / 2;
    this._plane.position.set(this.DOMAIN/2, this.BUILD_Y, this.DOMAIN/2);
    scene.add(this._plane);

    this._ray  = new THREE.Raycaster();
    this._v2   = new THREE.Vector2();
    this._down = null;

    this._onDown = this._onDown.bind(this);
    this._onUp   = this._onUp.bind(this);
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointerup',   this._onUp);
  }

  /* ── Mode toggle ───────────────────────────────────────────── */
  enable()  { this.enabled = true;  this.root.visible = true; }
  disable() {
    this.enabled = false;
    this.root.visible = false;
    this._detachGizmo();
  }

  setTransformControls(tc) {
    this.tc = tc;
    tc.addEventListener('objectChange', () => this._syncFromGizmo());
  }

  /* ── Palette / tool setters (called from main.js UI) ───────── */
  setActivePart(t)  { if (PART_TYPES[t]) this.activePart = t; }
  setGizmoMode(m)   { if (this.tc) this.tc.setMode(m); }
  setJointType(j)   { if (JOINT_TYPES.includes(j)) { this.jointType = j; if (this.selected) this.selected.joint = j; this._emit(); } }
  setChainLength(n) { this.chainLen = Math.max(1, Math.round(n)); }
  toggleMirror()    { this.mirror = !this.mirror; return this.mirror; }

  /* ── Geometry / material factories ─────────────────────────── */
  _makeGeometry(def) {
    const T = this.THREE, s = def.size;
    switch (def.geom) {
      case 'capsule': return new T.CapsuleGeometry(s[0], s[1], 4, 10);
      case 'sphere':  return new T.SphereGeometry(s[0], 16, 12);
      case 'box':     return new T.BoxGeometry(s[0], s[1], s[2] ?? s[0]);
      case 'cone':    return new T.ConeGeometry(s[0], s[1], 12);
      case 'plane':   return new T.PlaneGeometry(s[0], s[1]);
      default:        return new T.SphereGeometry(0.3, 12, 8);
    }
  }

  _makeMaterial(def) {
    const T = this.THREE;
    const thin = def.geom === 'plane';
    return new T.MeshStandardMaterial({
      color: def.col,
      roughness: thin ? 0.7 : 0.55,
      metalness: 0.0,
      side: thin ? T.DoubleSide : T.FrontSide,
      transparent: thin,
      opacity: thin ? 0.82 : 1.0,
    });
  }

  /* Build the visual object for a part (single mesh, or a Group for chains). */
  _buildObject(type) {
    const T = this.THREE, def = PART_TYPES[type];
    if (def.chain) {
      const grp = new T.Group();
      const segLen = def.size[1];
      let scale = 1;
      for (let i = 0; i < this.chainLen; i++) {
        const m = new T.Mesh(this._makeGeometry(def), this._makeMaterial(def));
        m.scale.setScalar(scale);
        m.position.set(0, 0, -i * segLen * scale * 1.05);
        m.castShadow = true;
        grp.add(m);
        scale *= (def.taper ?? 0.9);
      }
      return grp;
    }
    const m = new T.Mesh(this._makeGeometry(def), this._makeMaterial(def));
    m.castShadow = true;
    return m;
  }

  /* ── Placement ─────────────────────────────────────────────── */
  _addNode(type, pos, opts = {}) {
    const def = PART_TYPES[type];
    const obj = this._buildObject(type);
    obj.position.copy(pos);
    if (opts.rot)   obj.rotation.set(opts.rot[0], opts.rot[1], opts.rot[2]);
    if (opts.scale) obj.scale.multiplyScalar(opts.scale);
    this.root.add(obj);

    const node = {
      id: ++_uid, type, obj,
      joint: opts.joint ?? this.jointType ?? def.joint,
      scale: opts.scale ?? 1,
      mirrorOf: opts.mirrorOf ?? null,
    };
    obj.userData.nodeId = node.id;
    this.nodes.set(node.id, node);
    this.obj2node.set(obj, node);

    /* Mirror twin across the body centre-line (x = DOMAIN/2). */
    if (this.mirror && !opts.mirrorOf) {
      const cx = this.DOMAIN / 2;
      const mpos = pos.clone(); mpos.x = 2*cx - mpos.x;
      const twin = this._addNode(type, mpos, {
        joint: node.joint, scale: node.scale, mirrorOf: node.id,
        rot: opts.rot,
      });
      twin.obj.scale.x *= -1;   // flip geometry for true mirror
      node.mirrorId = twin.id;
    }
    return node;
  }

  _place(pos) {
    const node = this._addNode(this.activePart, pos);
    this._select(node);
    this._emit();
  }

  /* ── Selection + gizmo ─────────────────────────────────────── */
  _select(node) {
    this._clearHighlight();
    this.selected = node;
    if (node) {
      this._highlight(node.obj, true);
      if (this.tc) this.tc.attach(node.obj);
    }
    this._emit();
  }

  _detachGizmo() { if (this.tc) this.tc.detach(); this._clearHighlight(); this.selected = null; }

  _highlight(obj, on) {
    obj.traverse(o => {
      if (o.isMesh && o.material && o.material.emissive) {
        o.material.emissive.setHex(on ? 0x224466 : 0x000000);
      }
    });
  }
  _clearHighlight() { if (this.selected) this._highlight(this.selected.obj, false); }

  /* Keep node.scale in step with gizmo scaling (mirror twin follows). */
  _syncFromGizmo() {
    const n = this.selected;
    if (!n) return;
    if (n.mirrorId) {
      const twin = this.nodes.get(n.mirrorId);
      if (twin) {
        const cx = this.DOMAIN / 2;
        twin.obj.position.set(2*cx - n.obj.position.x, n.obj.position.y, n.obj.position.z);
        twin.obj.rotation.set(n.obj.rotation.x, -n.obj.rotation.y, -n.obj.rotation.z);
        twin.obj.scale.set(-n.obj.scale.x, n.obj.scale.y, n.obj.scale.z);
      }
    }
  }

  /* ── Selected-part operations (toolbar buttons) ────────────── */
  rotateSelected(axis, deg) {
    if (!this.selected) return;
    this.selected.obj.rotation[axis] += deg * Math.PI / 180;
    this._syncFromGizmo();
  }
  scaleSelected(v) {
    if (!this.selected) return;
    this.selected.scale = v;
    this.selected.obj.scale.setScalar(v);
    this._syncFromGizmo();
    this._emit();
  }
  deleteSelected() {
    const n = this.selected;
    if (!n) return;
    if (n.mirrorId) this._removeNode(this.nodes.get(n.mirrorId));
    this._removeNode(n);
    this._detachGizmo();
    this._emit();
  }
  clearAll() {
    this._detachGizmo();
    for (const n of this.nodes.values()) this._disposeObj(n.obj);
    this.nodes.clear(); this.obj2node.clear();
    this._emit();
  }

  _removeNode(n) {
    if (!n) return;
    this.root.remove(n.obj);
    this._disposeObj(n.obj);
    this.obj2node.delete(n.obj);
    this.nodes.delete(n.id);
  }
  _disposeObj(obj) {
    obj.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); } });
  }

  /* ── Pointer handling (place vs select vs camera-drag) ─────── */
  _onDown(e) { if (this.enabled) this._down = [e.clientX, e.clientY]; }

  _onUp(e) {
    if (!this.enabled || !this._down) { this._down = null; return; }
    const dx = e.clientX - this._down[0], dy = e.clientY - this._down[1];
    this._down = null;
    if (Math.hypot(dx, dy) >= 8) return;          // drag → camera, ignore
    if (this.tc && this.tc.dragging) return;       // gizmo handled it

    const rect = this.canvas.getBoundingClientRect();
    this._v2.set(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1
    );
    this._ray.setFromCamera(this._v2, this.cam);

    /* Hit an existing part? → select it. */
    const meshes = [];
    for (const n of this.nodes.values()) meshes.push(n.obj);
    const hits = this._ray.intersectObjects(meshes, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !this.obj2node.has(o)) o = o.parent;
      if (o) { this._select(this.obj2node.get(o)); return; }
    }

    /* Otherwise place a new part on the build platform. */
    const ph = this._ray.intersectObject(this._plane);
    if (ph.length) this._place(ph[0].point);
  }

  _emit() {
    const ev = new CustomEvent('creature-change', {
      detail: {
        parts: this.nodes.size,
        selected: this.selected
          ? { type: this.selected.type, joint: this.selected.joint, scale: this.selected.scale }
          : null,
      },
    });
    this.canvas.dispatchEvent(ev);
  }

  /* ── Presets ───────────────────────────────────────────────── */
  loadPreset(name) {
    this.clearAll();
    const T = this.THREE, cx = this.DOMAIN/2, y = this.BUILD_Y, cz = this.DOMAIN/2;
    const V = (x,yy,z) => new T.Vector3(x,yy,z);
    const savedChain = this.chainLen, savedMirror = this.mirror;
    this.mirror = false;

    if (name === 'snake') {
      this.chainLen = 16;
      this._addNode('SPINE', V(cx, y, cz));
      this.chainLen = savedChain;
      this._addNode('HEAD', V(cx, y, cz + 0.5), { scale: 0.8 });
    } else if (name === 'quadruped') {
      this._addNode('TORSO', V(cx, y, cz));
      this._addNode('HEAD',  V(cx, y + 0.2, cz + 1.0), { scale: 0.8 });
      this.chainLen = 5; this._addNode('TAIL', V(cx, y + 0.1, cz - 0.7)); this.chainLen = savedChain;
      const legs = [[-0.45, 0.7], [0.45, 0.7], [-0.45, -0.5], [0.45, -0.5]];
      for (const [lx, lz] of legs) {
        const leg = this._addNode('LIMB', V(cx + lx, y - 0.5, cz + lz));
        leg.obj.rotation.x = Math.PI * 0.04;
      }
    } else if (name === 'bird') {
      this._addNode('TORSO', V(cx, y, cz), { scale: 0.8 });
      this._addNode('HEAD',  V(cx, y + 0.4, cz + 0.7), { scale: 0.6 });
      const wl = this._addNode('WING', V(cx - 0.8, y + 0.2, cz));
      wl.obj.rotation.z = Math.PI * 0.10;
      const wr = this._addNode('WING', V(cx + 0.8, y + 0.2, cz));
      wr.obj.rotation.z = -Math.PI * 0.10; wr.obj.scale.x *= -1;
      this.chainLen = 4; this._addNode('TAIL', V(cx, y, cz - 0.8)); this.chainLen = savedChain;
    }

    this.mirror = savedMirror;
    this._emit();
  }

  /* ── Save / load ───────────────────────────────────────────── */
  save() {
    const data = [];
    for (const n of this.nodes.values()) {
      if (n.mirrorOf) continue;   // twins are rebuilt from their source
      const o = n.obj;
      data.push({
        type: n.type, joint: n.joint, scale: n.scale,
        pos: [o.position.x, o.position.y, o.position.z],
        rot: [o.rotation.x, o.rotation.y, o.rotation.z],
        mir: !!n.mirrorId,
      });
    }
    try { localStorage.setItem('fc_creature', JSON.stringify(data)); return true; }
    catch (_) { return false; }
  }

  load() {
    let raw;
    try { raw = localStorage.getItem('fc_creature'); } catch (_) { return false; }
    if (!raw) return false;
    let data; try { data = JSON.parse(raw); } catch (_) { return false; }
    if (!Array.isArray(data)) return false;

    this.clearAll();
    const savedMirror = this.mirror;
    for (const d of data) {
      this.mirror = !!d.mir;
      this._addNode(d.type, new this.THREE.Vector3(...d.pos), {
        rot: d.rot, scale: d.scale, joint: d.joint,
      });
    }
    this.mirror = savedMirror;
    this._emit();
    return true;
  }

  /* ── Build-panel HTML (injected by main.js) ────────────────── */
  static buildPartPanelHTML() {
    const partBtns = PART_ORDER.map(k => {
      const d = PART_TYPES[k];
      const hex = '#' + d.col.toString(16).padStart(6, '0');
      return `<button class="part-btn" data-part="${k}">
        <span class="sw" style="background:${hex}"></span>${d.label}</button>`;
    }).join('');

    return `
      <div class="ptitle">Body Parts</div>
      <div class="part-grid">${partBtns}</div>

      <div class="ptitle" style="margin-top:14px">Presets</div>
      <div class="cbtn-row">
        <button class="cbtn" data-preset="snake">Snake</button>
        <button class="cbtn" data-preset="quadruped">Quadruped</button>
        <button class="cbtn" data-preset="bird">Bird</button>
      </div>

      <div class="ptitle" style="margin-top:14px">Gizmo</div>
      <div class="cbtn-row">
        <button class="cbtn on" id="btn-move">Move</button>
        <button class="cbtn" id="btn-rotate">Rotate</button>
        <button class="cbtn" id="btn-mirror">Mirror: off</button>
      </div>
      <div class="cbtn-row">
        <button class="cbtn" id="btn-rotx">Rot X+</button>
        <button class="cbtn" id="btn-roty">Rot Y+</button>
        <button class="cbtn" id="btn-del">Delete</button>
      </div>

      <div class="ptitle" style="margin-top:14px">Joint</div>
      <div class="cbtn-row">
        <button class="cbtn" data-joint="ball">Ball</button>
        <button class="cbtn" data-joint="hinge">Hinge</button>
        <button class="cbtn" data-joint="weld">Weld</button>
      </div>

      <div class="ptitle" style="margin-top:14px">Chain Length: <span id="chain-val">6</span></div>
      <input type="range" id="chain-len" min="1" max="24" step="1" value="6">

      <div class="ptitle" style="margin-top:10px">Part Scale: <span id="scale-val">1.0</span>×</div>
      <input type="range" id="part-scale" min="0.3" max="3" step="0.1" value="1">

      <div class="cbtn-row" style="margin-top:14px">
        <button class="cbtn" id="btn-save">Save</button>
        <button class="cbtn" id="btn-load">Load</button>
        <button class="cbtn" id="btn-clear">Clear</button>
      </div>

      <div id="sel-info">None selected (0 parts)</div>
    `;
  }
}
