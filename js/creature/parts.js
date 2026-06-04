/**
 * Body part library for the creature creator.
 * Each part definition describes geometry, default material, constraints,
 * and how it connects to its parent.
 */

export const PART_TYPES = {

  /* ── Structural / skeletal ───────────────────────────────────── */
  BONE: {
    label:'Bone',
    icon:'🦴',
    geometry:{ type:'capsule', radius:0.12, length:0.7 },
    defaultMat: 'BONE',
    color: 0xf0e8c8,
    canHaveChildren: true,
    defaultJoint: 'BALL',
    desc: 'Rigid skeletal segment',
  },
  SPINE: {
    label:'Spine Segment',
    icon:'〰',
    geometry:{ type:'capsule', radius:0.08, length:0.35 },
    defaultMat: 'BONE',
    color: 0xe8ddb8,
    canHaveChildren: true,
    defaultJoint: 'HINGE',
    repeat: 6,       // default chain count
    desc: 'Chained spinal segment (snake, neck, tail)',
  },
  HEAD: {
    label:'Head',
    icon:'⬭',
    geometry:{ type:'sphere', radius:0.28 },
    defaultMat: 'BONE',
    color: 0xffccaa,
    canHaveChildren: true,
    defaultJoint: 'BALL',
    desc: 'Cranium/head',
  },
  TORSO: {
    label:'Torso',
    icon:'▬',
    geometry:{ type:'box', w:0.5, h:0.65, d:0.35 },
    defaultMat: 'BONE',
    color: 0xffbbaa,
    canHaveChildren: true,
    isRoot: true,
    desc: 'Main body; typically the creature root',
  },

  /* ── Appendages ─────────────────────────────────────────────── */
  LIMB: {
    label:'Limb Segment',
    icon:'|',
    geometry:{ type:'capsule', radius:0.09, length:0.55 },
    defaultMat: 'BONE',
    color: 0xffbbaa,
    canHaveChildren: true,
    defaultJoint: 'HINGE',
    desc: 'Leg / arm segment',
  },
  TAIL: {
    label:'Tail',
    icon:'〜',
    geometry:{ type:'capsule', radius:0.07, length:0.4 },
    defaultMat: 'BONE',
    color: 0xeebb99,
    canHaveChildren: true,
    defaultJoint: 'BALL',
    repeat: 8,
    taper: true,   // radius decreases along chain
    desc: 'Tapered tail chain',
  },
  TENTACLE: {
    label:'Tentacle',
    icon:'~',
    geometry:{ type:'capsule', radius:0.06, length:0.38 },
    defaultMat: 'MUSCLE',
    color: 0xcc8866,
    canHaveChildren: true,
    defaultJoint: 'BALL',
    repeat: 10,
    taper: true,
    desc: 'Flexible tentacle / tendril chain',
  },

  /* ── Wings / membranes ──────────────────────────────────────── */
  WING: {
    label:'Wing',
    icon:'△',
    geometry:{ type:'wing', span:1.6, chord:0.7, sweep:0.3 },
    defaultMat: 'MEMBRANE',
    color: 0xddbbaa,
    canHaveChildren: false,
    mirror: true,
    desc: 'Wing membrane (dragon/bird)',
  },
  FIN: {
    label:'Fin',
    icon:'◁',
    geometry:{ type:'fin', width:0.6, height:0.4 },
    defaultMat: 'MEMBRANE',
    color: 0x88bbcc,
    canHaveChildren: false,
    desc: 'Fish fin / stabiliser',
  },

  /* ── Detail / surface parts ─────────────────────────────────── */
  CLAW: {
    label:'Claw',
    icon:'⟓',
    geometry:{ type:'cone', radius:0.06, height:0.25, curve:0.3 },
    defaultMat: 'CHITIN',
    color: 0xaa9988,
    canHaveChildren: false,
    repeat: 3,
    desc: 'Claw / talon',
  },
  HORN: {
    label:'Horn',
    icon:'△',
    geometry:{ type:'cone', radius:0.07, height:0.40 },
    defaultMat: 'BONE',
    color: 0xeeeecc,
    canHaveChildren: false,
    desc: 'Horn / spike',
  },
  EYE: {
    label:'Eye',
    icon:'◉',
    geometry:{ type:'sphere', radius:0.10 },
    defaultMat: 'ORGAN',
    color: 0x222222,
    canHaveChildren: false,
    desc: 'Eye',
  },
};

/* Ordered list for the UI panel */
export const PART_ORDER = [
  'TORSO','HEAD','BONE','SPINE','LIMB','TAIL','TENTACLE',
  'WING','FIN','CLAW','HORN','EYE',
];

/* Joint type definitions */
export const JOINT_TYPES = {
  BALL:  { label:'Ball & Socket', icon:'●', dof:3, limitCone:45 },
  HINGE: { label:'Hinge',         icon:'⊟', dof:1, limitLow:-90, limitHigh:90 },
  FIXED: { label:'Fixed/Weld',    icon:'✕', dof:0 },
};
