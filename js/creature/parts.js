/**
 * Body-part catalogue for the creature builder.
 *
 * Each part describes how to build its mesh (a primitive geometry + size),
 * a default colour, and the joint type used when attaching to a parent.
 * `chain` parts (spine, tail, tentacle) are placed as a tapered series of
 * segments whose count is controlled by the chain-length slider.
 */

export const JOINT_TYPES = ['ball', 'hinge', 'weld'];

/* geom: 'capsule' | 'sphere' | 'box' | 'cone' | 'plane'
   size: [a, b, c] interpreted per-geometry (see builder._makeGeometry)        */
export const PART_TYPES = {
  BONE:     { label:'Bone',     geom:'capsule', size:[0.10, 0.70], col:0xece6d2, joint:'weld'  },
  SPINE:    { label:'Spine',    geom:'capsule', size:[0.16, 0.34], col:0xd9c9a0, joint:'ball',  chain:true, taper:0.92 },
  HEAD:     { label:'Head',     geom:'sphere',  size:[0.40],       col:0xc9b48c, joint:'ball'  },
  TORSO:    { label:'Torso',    geom:'sphere',  size:[0.62],       col:0xb98f63, joint:'ball'  },
  LIMB:     { label:'Limb',     geom:'capsule', size:[0.13, 0.80], col:0xb07a4f, joint:'hinge' },
  TAIL:     { label:'Tail',     geom:'capsule', size:[0.14, 0.30], col:0xc08a55, joint:'ball',  chain:true, taper:0.85 },
  TENTACLE: { label:'Tentacle', geom:'capsule', size:[0.12, 0.26], col:0x9a6fb0, joint:'ball',  chain:true, taper:0.88 },
  // Wings/fins are lofted as real NACA airfoil sections (size = [span, chord]).
  // A cambered wing makes lift even at 0° AoA; a symmetric fin is a neutral
  // control surface. The same params voxelize into the LBM, so the shape you
  // build is the shape the air feels.
  WING:     { label:'Wing',     geom:'airfoil', size:[1.40, 0.90], col:0x88aacc, joint:'hinge', airfoil:{ m:0.04, p:0.40, t:0.12 } },
  FIN:      { label:'Fin',      geom:'airfoil', size:[0.70, 0.50], col:0x6fb0c0, joint:'hinge', airfoil:{ m:0.00, p:0.40, t:0.09 } },
  CLAW:     { label:'Claw',     geom:'cone',    size:[0.10, 0.34], col:0x3a3530, joint:'weld'  },
  HORN:     { label:'Horn',     geom:'cone',    size:[0.12, 0.52], col:0xe8e0cc, joint:'weld'  },
  EYE:      { label:'Eye',      geom:'sphere',  size:[0.13],       col:0x141820, joint:'weld'  },
};

/* Display order in the build palette. */
export const PART_ORDER = [
  'TORSO', 'HEAD', 'SPINE', 'LIMB', 'TAIL', 'TENTACLE',
  'WING', 'FIN', 'CLAW', 'HORN', 'BONE', 'EYE',
];
