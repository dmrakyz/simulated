/**
 * Creature Builder — Phase 2
 *
 * Manages the creature graph (nodes = body parts, edges = joints) and
 * drives the THREE.js scene in BUILD mode.
 *
 * Architecture:
 *   CreatureNode  — one body part: geometry mesh + joint to parent
 *   CreatureGraph — the whole creature (tree of nodes)
 *   CreatureBuilder — the interactive editor (selection, placement, gizmo)
 */

import { PART_TYPES, PART_ORDER, JOINT_TYPES } from './parts.js';

let _nodeIdSeq = 0;
const uid = () => `n${++_nodeIdSeq}`;

/* ── Node ───────────────────────────────────────────────────────── */
export class CreatureNode {
  constructor(partType, position, parentId=null) {
    this.id       = uid();
    this.type     = partType;           // key into PART_TYPES
    this.parentId = parentId;
    this.childIds = [];
    this.position = position.clone();   // THREE.Vector3 in world space
    this.rotation = { x:0, y:0, z:0 }; // Euler angles (radians)
    this.scale    = 1.0;
    this.mirror   = false;
    this.repeatN  = PART_TYPES[partType]?.repeat ?? 1;
    this.jointType = PART_TYPES[partType]?.defaultJoint ?? 'BALL';
    this.mesh     = null;               // THREE.Mesh, built on demand
    this.mirrorMesh = null;
  }
}

/* ── Graph ──────────────────────────────────────────────────────── */
export class CreatureGraph {
  constructor() {
    this.nodes  = new Map();   // id → CreatureNode
    this.rootId = null;
  }

  addNode(partType, position, parentId=null) {
    const node = new CreatureNode(partType, position, parentId);
    this.nodes.set(node.id, node);
    if (parentId && this.nodes.has(parentId)) {
      this.nodes.get(parentId).childIds.push(node.id);
    }
    if (!this.rootId) this.rootId = node.id;
    return node;
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    // Recursively remove children
    [...node.childIds].forEach(cid => this.removeNode(cid));
    // Unlink from parent
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) parent.childIds = parent.childIds.filter(c => c !== id);
    }
    if (this.rootId === id) this.rootId = null;
    this.nodes.delete(id);
  }

  toJSON() {
    return {
      rootId: this.rootId,
      nodes: [...this.nodes.entries()].map(([id, n]) => ({
        id, type:n.type, parentId:n.parentId, childIds:[...n.childIds],
        position:{x:n.position.x,y:n.position.y,z:n.position.z},
        rotation:n.rotation, scale:n.scale, mirror:n.mirror,
        repeatN:n.repeatN, jointType:n.jointType,
      })),
    };
  }

  static fromJSON(THREE, json) {
    const g = new CreatureGraph();
    g.rootId = json.rootId;
    for (const nd of json.nodes) {
      const node = new CreatureNode(nd.type, new THREE.Vector3(nd.position.x,nd.position.y,nd.position.z), nd.parentId);
      Object.assign(node, { id:nd.id, childIds:nd.childIds, rotation:nd.rotation,
        scale:nd.scale, mirror:nd.mirror, repeatN:nd.repeatN, jointType:nd.jointType });
      g.nodes.set(node.id, node);
    }
    return g;
  }
}

/* ── Builder ────────────────────────────────────────────────────── */
export class CreatureBuilder {
  constructor(THREE, scene, camera, renderer, domElement) {
    this.THREE      = THREE;
    this.scene      = scene;
    this.camera     = camera;
    this.renderer   = renderer;
    this.dom        = domElement;

    this.graph      = new CreatureGraph();
    this.selectedId = null;
    this.activePart = 'TORSO';    // part type to place next
    this.active     = false;      // is BUILD mode on?

    this._meshGroup = new THREE.Group();
    scene.add(this._meshGroup);

    this._raycaster = new THREE.Raycaster();
    this._mouse     = new THREE.Vector2();
    this._placePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(80,80),
      new THREE.MeshBasicMaterial({visible:false, side:THREE.DoubleSide})
    );
    this._placePlane.rotation.x = -Math.PI/2;
    this._placePlane.position.y = 0;
    scene.add(this._placePlane);

    this._materials = this._buildMaterials();
    this._hoverMat  = new THREE.MeshStandardMaterial({ color:0x00e5ff, wireframe:true, opacity:0.5, transparent:true });
    this._selMat    = new THREE.MeshStandardMaterial({ color:0x00ff88, wireframe:false, emissive:0x002200 });

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);

    this._gizmoGroup = new THREE.Group();
    scene.add(this._gizmoGroup);
    this._buildAxisGizmos();
  }

  /* ── Materials ─────────────────────────────────────────────── */
  _buildMaterials() {
    const THREE = this.THREE;
    const mk = (col, rough=0.6, metal=0) =>
      new THREE.MeshStandardMaterial({ color:col, roughness:rough, metalness:metal });
    return {
      TORSO:    mk(0xffbbaa, 0.75),
      HEAD:     mk(0xffccbb, 0.75),
      BONE:     mk(0xf0e8c8, 0.65),
      SPINE:    mk(0xe8ddb8, 0.65),
      LIMB:     mk(0xffbbaa, 0.70),
      TAIL:     mk(0xeebb99, 0.70),
      TENTACLE: mk(0xcc8866, 0.80),
      WING:     mk(0xddbbaa, 0.55, 0.1),
      FIN:      mk(0x88bbcc, 0.50, 0.05),
      CLAW:     mk(0xaa9988, 0.40, 0.2),
      HORN:     mk(0xeeeecc, 0.35),
      EYE:      mk(0x222222, 0.20, 0.3),
    };
  }

  /* ── Geometry builders ─────────────────────────────────────── */
  _buildGeometry(partType, scale=1) {
    const THREE = this.THREE;
    const def = PART_TYPES[partType];
    if (!def) return new THREE.SphereGeometry(0.2*scale);
    const g = def.geometry;

    switch(g.type) {
      case 'sphere':  return new THREE.SphereGeometry(g.radius*scale, 16, 12);
      case 'capsule': return new THREE.CapsuleGeometry(g.radius*scale, g.length*scale, 8, 16);
      case 'box':     return new THREE.BoxGeometry(g.w*scale, g.h*scale, g.d*scale, 2,2,2);
      case 'cone':    return new THREE.ConeGeometry(g.radius*scale, g.height*scale, 12);
      case 'wing': {
        // Simple trapezoidal wing using a custom flat shape
        const s = scale;
        const shape = new THREE.Shape();
        const span=g.span*s, chord=g.chord*s, sweep=g.sweep*s;
        shape.moveTo(0,0);
        shape.lineTo(sweep, span);
        shape.lineTo(sweep + chord*0.5, span);
        shape.lineTo(chord, 0);
        shape.closePath();
        const extSettings = { depth:0.015*s, bevelEnabled:false };
        return new THREE.ExtrudeGeometry(shape, extSettings);
      }
      case 'fin': {
        const s=scale;
        const shape = new THREE.Shape();
        shape.moveTo(0,0);
        shape.lineTo(g.width*s, g.height*s*0.4);
        shape.lineTo(g.width*s*0.5, g.height*s);
        shape.closePath();
        return new THREE.ExtrudeGeometry(shape, { depth:0.012*s, bevelEnabled:false });
      }
      default: return new THREE.SphereGeometry(0.2*scale);
    }
  }

  /* ── Build THREE.js mesh for a node ─────────────────────────── */
  _buildMesh(node) {
    const THREE = this.THREE;
    const geo = this._buildGeometry(node.type, node.scale);
    const mat = (this._materials[node.type] ?? this._materials.BONE).clone();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(node.position);
    mesh.rotation.set(node.rotation.x, node.rotation.y, node.rotation.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.nodeId = node.id;
    return mesh;
  }

  _rebuildMesh(node) {
    if (node.mesh) { this._meshGroup.remove(node.mesh); node.mesh.geometry.dispose(); }
    if (node.mirrorMesh) { this._meshGroup.remove(node.mirrorMesh); node.mirrorMesh.geometry.dispose(); }
    node.mesh = this._buildMesh(node);
    this._meshGroup.add(node.mesh);
    if (node.mirror) {
      node.mirrorMesh = node.mesh.clone();
      node.mirrorMesh.position.x = -node.position.x;
      node.mirrorMesh.userData.nodeId = node.id + '_mirror';
      this._meshGroup.add(node.mirrorMesh);
    }
  }

  /* ── Joint visualisation ───────────────────────────────────── */
  _drawJoints() {
    const THREE = this.THREE;
    // Remove old joint visuals
    while (this._gizmoGroup.children.length > 3) { // keep axis arrows
      const c = this._gizmoGroup.children[3];
      this._gizmoGroup.remove(c);
    }
    const lineMat = new THREE.LineBasicMaterial({ color:0xffff00, opacity:0.5, transparent:true });
    for (const [,node] of this.graph.nodes) {
      if (!node.parentId || !node.mesh) continue;
      const parent = this.graph.nodes.get(node.parentId);
      if (!parent?.mesh) continue;
      const pts = [parent.mesh.position.clone(), node.mesh.position.clone()];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this._gizmoGroup.add(new THREE.Line(geo, lineMat));
    }
  }

  /* ── Axis gizmos (small XYZ arrows) ────────────────────────── */
  _buildAxisGizmos() {
    const THREE = this.THREE;
    const mk = (dir, col) => {
      const mat = new THREE.LineBasicMaterial({ color:col });
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]);
      return new THREE.Line(geo, mat);
    };
    this._gizmoGroup.add(mk(new THREE.Vector3(1,0,0),0xff3333));
    this._gizmoGroup.add(mk(new THREE.Vector3(0,1,0),0x33ff33));
    this._gizmoGroup.add(mk(new THREE.Vector3(0,0,1),0x3388ff));
    this._gizmoGroup.visible = false;
  }

  /* ── Interaction ────────────────────────────────────────────── */
  enable() {
    this.active = true;
    this._meshGroup.visible = true;
    this._gizmoGroup.visible = true;
    this.dom.addEventListener('pointerdown', this._onPointerDown);
    this.dom.addEventListener('pointermove', this._onPointerMove);
  }

  disable() {
    this.active = false;
    this._gizmoGroup.visible = false;
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    this.dom.removeEventListener('pointermove', this._onPointerMove);
  }

  setActivePart(type) { this.activePart = type; }

  _screenToNDC(e) {
    const rect = this.dom.getBoundingClientRect();
    this._mouse.set(
      ((e.clientX - rect.left) / rect.width)  *  2 - 1,
      -((e.clientY - rect.top)  / rect.height) *  2 + 1
    );
  }

  _pickNodeAtScreen(e) {
    this._screenToNDC(e);
    this._raycaster.setFromCamera(this._mouse, this.camera);
    const meshes = [...this.graph.nodes.values()].filter(n=>n.mesh).map(n=>n.mesh);
    const hits = this._raycaster.intersectObjects(meshes);
    if (!hits.length) return null;
    return hits[0].object.userData.nodeId ?? null;
  }

  _getPlacementPos(e) {
    this._screenToNDC(e);
    this._raycaster.setFromCamera(this._mouse, this.camera);
    const hits = this._raycaster.intersectObject(this._placePlane);
    return hits.length ? hits[0].point : null;
  }

  _onPointerDown(e) {
    if (!this.active) return;
    const hitNodeId = this._pickNodeAtScreen(e);
    if (hitNodeId) {
      // Select existing node
      this._select(hitNodeId);
    } else {
      // Place a new part
      const pos = this._getPlacementPos(e);
      if (!pos) return;
      pos.y = Math.max(0, pos.y);
      const parentId = this.selectedId;
      const node = this.graph.addNode(this.activePart, pos, parentId);
      this._rebuildMesh(node);
      this._drawJoints();
      this._select(node.id);
      this._emitChange();
    }
  }

  _onPointerMove(e) {
    // Visual hover highlight (future: show placement ghost)
  }

  _select(id) {
    // Deselect previous
    if (this.selectedId) {
      const prev = this.graph.nodes.get(this.selectedId);
      if (prev?.mesh) prev.mesh.material = this._materials[prev.type]?.clone() ?? this._materials.BONE.clone();
    }
    this.selectedId = id;
    if (id) {
      const node = this.graph.nodes.get(id);
      if (node?.mesh) node.mesh.material = this._selMat.clone();
      this._gizmoGroup.position.copy(node.mesh.position);
    }
    this._emitChange();
  }

  deleteSelected() {
    if (!this.selectedId) return;
    const node = this.graph.nodes.get(this.selectedId);
    if (node) {
      if (node.mesh) this._meshGroup.remove(node.mesh);
      if (node.mirrorMesh) this._meshGroup.remove(node.mirrorMesh);
    }
    this.graph.removeNode(this.selectedId);
    this.selectedId = null;
    this._drawJoints();
    this._emitChange();
  }

  toggleMirror() {
    if (!this.selectedId) return;
    const node = this.graph.nodes.get(this.selectedId);
    if (!node) return;
    node.mirror = !node.mirror;
    this._rebuildMesh(node);
    this._emitChange();
  }

  scaleSelected(factor) {
    if (!this.selectedId) return;
    const node = this.graph.nodes.get(this.selectedId);
    if (!node) return;
    node.scale = Math.max(0.1, Math.min(10, node.scale * factor));
    this._rebuildMesh(node);
    this._drawJoints();
    this._emitChange();
  }

  /* Save/load creature */
  save(name='creature') {
    const json = this.graph.toJSON();
    localStorage.setItem('fc_creature_' + name, JSON.stringify(json));
    console.log('[Creature] Saved:', name);
  }

  load(name='creature') {
    const raw = localStorage.getItem('fc_creature_' + name);
    if (!raw) return false;
    const json = JSON.parse(raw);
    // Clear existing
    for (const [,n] of this.graph.nodes) {
      if (n.mesh) this._meshGroup.remove(n.mesh);
    }
    this.graph = CreatureGraph.fromJSON(this.THREE, json);
    for (const [,node] of this.graph.nodes) this._rebuildMesh(node);
    this._drawJoints();
    console.log('[Creature] Loaded:', name, this.graph.nodes.size, 'parts');
    return true;
  }

  _emitChange() {
    this.dom.dispatchEvent(new CustomEvent('creature-change', {
      detail: { graph: this.graph, selectedId: this.selectedId }
    }));
  }

  /* Build the left-panel HTML for the creature builder */
  static buildPartPanelHTML() {
    let html = '<div class="ptitle">Body Parts</div>';
    for (const key of PART_ORDER) {
      const def = PART_TYPES[key];
      html += `<button class="mfbtn part-btn" data-part="${key}" title="${def.desc}">
        <span style="font-size:14px">${def.icon}</span> ${def.label}
      </button>`;
    }
    html += `<div class="ptitle" style="margin-top:14px">Edit</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="mbtn" id="btn-mirror">⇔ Mirror</button>
      <button class="mbtn" id="btn-del">✕ Delete</button>
    </div>
    <div class="ptitle" style="margin-top:14px">Scale</div>
    <input type="range" id="part-scale" min="0.2" max="5" step="0.1" value="1">
    <div style="font-size:10px;color:rgba(255,255,255,.35);margin-top:3px">
      Scale: <span id="scale-val">1.0</span>×
    </div>
    <div class="ptitle" style="margin-top:14px">Creature</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="mbtn" id="btn-save">💾 Save</button>
      <button class="mbtn" id="btn-load">📂 Load</button>
    </div>`;
    return html;
  }
}
