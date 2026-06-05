/**
 * MLS-MPM Physics Engine — Multi-Velocity-Field
 *
 * Three independent velocity fields share the same grid topology but carry
 * separate momentum. At each substep the fields couple through a contact
 * exchange that applies Newton's 3rd-law impulses in every cell occupied by
 * more than one field. This replaces the old single-field hack (which caused
 * cross-material sticking) and creates a real medium for future wing/fin lift.
 *
 *  Field 0 — LIQUID : water (0), lava (2), honey (4), oil (6)
 *  Field 1 — SOLID  : sand (1), snow (3), mud (5), ice (7)
 *  Field 2 — AIR    : air (8) — invisible, zero gravity, persists across resets
 *
 * Coupling coefficients (per field-pair, used in the contact step):
 *   liquid ↔ solid : 0.30  (sand sinks in water, ice floats — buoyancy via contact)
 *   liquid ↔ air   : 0.012 (water barely slows in air; air gets swept by flow)
 *   solid  ↔ air   : 0.020 (solids feel mild air drag; air pushed by moving wings)
 *
 * Within the liquid field, heavy-fluid / light-fluid separation (water rising
 * through lava) is reinforced by a short buoyancy column scan — the same
 * Archimedes trick that was used in the single-field version, now narrowed to
 * field-0 particles only.
 *
 * Air field has zero gravity so the background stays evenly distributed.
 * Air particles are auto-spawned on init/reset and are never rendered.
 */

/* ── Material table ─────────────────────────────────────────────── */
export const MATERIALS = [
  // id 0: Water
  { name:'Water', col:0x2299ff, rho:1000, E:7.0e5, type:'fluid',    cScale:1.00, vdamp:1.000 },
  // id 1: Sand
  { name:'Sand',  col:0xd9b25f, rho:1600, E:5.0e5, type:'granular', cScale:0.20, vdamp:0.998 },
  // id 2: Lava
  { name:'Lava',  col:0xff5522, rho:3100, E:8.0e5, type:'fluid',    cScale:0.45, vdamp:0.992 },
  // id 3: Snow
  { name:'Snow',  col:0xeef3ff, rho:400,  E:1.2e5, nu:0.20, type:'elastic', cScale:1.00, vdamp:0.999 },
  // id 4: Honey
  { name:'Honey', col:0xffb022, rho:1400, E:6.0e5, type:'fluid',    cScale:0.30, vdamp:0.992 },
  // id 5: Mud
  { name:'Mud',   col:0x7a5a38, rho:1800, E:4.0e5, type:'granular', cScale:0.28, vdamp:0.996 },
  // id 6: Oil
  { name:'Oil',   col:0x3c3a22, rho:900,  E:6.0e5, type:'fluid',    cScale:0.80, vdamp:0.997 },
  // id 7: Ice — rho below water so it clearly floats
  { name:'Ice',   col:0xaadcff, rho:780,  E:8.0e5, nu:0.32, type:'elastic', cScale:1.00, vdamp:1.000 },
  // id 8: Air — background medium. Not rendered. Gravity cancelled in its field.
  { name:'Air',   col:0x88aacc, rho:40,   E:5.0e4, type:'fluid',    cScale:1.00, vdamp:1.000 },
];

// Field assignment per material id (indexed 0‥8)
// 0 = liquid  1 = solid  2 = air
const MAT_FIELD = new Uint8Array([0,1,0,1,0,1,0,1,2]);

// Coupling coefficients [fieldA][fieldB] (symmetric)
// liquid↔solid=0.30  liquid↔air=0.012  solid↔air=0.020
const COUP = [
  [0,    0.30, 0.012],
  [0.30, 0,    0.020],
  [0.012,0.020, 0   ],
];

const TYPE_CODE = { fluid: 0, granular: 1, elastic: 2 };

for (const m of MATERIALS) {
  const nu = m.nu ?? 0.3;
  m._mu = m.E / (2 * (1 + nu));
  m._la = m.E * nu / ((1 + nu) * (1 - 2 * nu));
}

const _R = new Float64Array(9);

function polarR(F, o) {
  let r0=F[o],r1=F[o+1],r2=F[o+2],r3=F[o+3],r4=F[o+4],r5=F[o+5],r6=F[o+6],r7=F[o+7],r8=F[o+8];
  for (let it = 0; it < 16; it++) {
    const det = r0*(r4*r8-r5*r7) - r1*(r3*r8-r5*r6) + r2*(r3*r7-r4*r6);
    if (Math.abs(det) < 1e-9) break;
    const id = 1/det;
    const i0=(r4*r8-r5*r7)*id,i1=(r2*r7-r1*r8)*id,i2=(r1*r5-r2*r4)*id;
    const i3=(r5*r6-r3*r8)*id,i4=(r0*r8-r2*r6)*id,i5=(r2*r3-r0*r5)*id;
    const i6=(r3*r7-r4*r6)*id,i7=(r1*r6-r0*r7)*id,i8=(r0*r4-r1*r3)*id;
    const n0=.5*(r0+i0),n1=.5*(r1+i3),n2=.5*(r2+i6),n3=.5*(r3+i1),n4=.5*(r4+i4),
          n5=.5*(r5+i7),n6=.5*(r6+i2),n7=.5*(r7+i5),n8=.5*(r8+i8);
    const cv=Math.abs(n0-r0)+Math.abs(n4-r4)+Math.abs(n8-r8);
    r0=n0;r1=n1;r2=n2;r3=n3;r4=n4;r5=n5;r6=n6;r7=n7;r8=n8;
    if (cv < 1e-6) break;
  }
  _R[0]=r0;_R[1]=r1;_R[2]=r2;_R[3]=r3;_R[4]=r4;_R[5]=r5;_R[6]=r6;_R[7]=r7;_R[8]=r8;
}

export class MPM {
  constructor(opts = {}) {
    this.N    = opts.gridN        || 48;
    this.DX   = opts.dx           || 0.25;
    this.MAX  = opts.maxParticles || 24000;
    this.sub  = opts.substeps     || 8;
    this.gravity = opts.gravity   ?? -9.8;

    this.INV    = 1 / this.DX;
    this.N3     = this.N ** 3;
    this.DOMAIN = this.N * this.DX;
    this.PVOL   = (this.DX * 0.5) ** 3;
    this.DINV   = 4 * this.INV * this.INV;

    /* particle buffers */
    const M = this.MAX;
    this.px  = new Float32Array(M);
    this.py  = new Float32Array(M);
    this.pz  = new Float32Array(M);
    this.pvx = new Float32Array(M);
    this.pvy = new Float32Array(M);
    this.pvz = new Float32Array(M);
    this.pC  = new Float32Array(M * 9);
    this.pF  = new Float32Array(M * 9);
    this.pJ  = new Float32Array(M);
    this.pMt = new Uint8Array(M);
    this.nP  = 0;

    /* Three independent velocity fields (liquid / solid / air). */
    this.gM  = [new Float32Array(this.N3), new Float32Array(this.N3), new Float32Array(this.N3)];
    this.gVx = [new Float32Array(this.N3), new Float32Array(this.N3), new Float32Array(this.N3)];
    this.gVy = [new Float32Array(this.N3), new Float32Array(this.N3), new Float32Array(this.N3)];
    this.gVz = [new Float32Array(this.N3), new Float32Array(this.N3), new Float32Array(this.N3)];

    this._WX = new Float32Array(3);
    this._WY = new Float32Array(3);
    this._WZ = new Float32Array(3);

    const NM = MATERIALS.length;
    this._mType = new Uint8Array(NM);
    this._mMass = new Float64Array(NM);
    this._mE    = new Float64Array(NM);
    this._mMu   = new Float64Array(NM);
    this._mLa   = new Float64Array(NM);
    this._mCs   = new Float64Array(NM);
    this._mVd   = new Float64Array(NM);
    this._mRho  = new Float64Array(NM);
    for (let i = 0; i < NM; i++) {
      const m = MATERIALS[i];
      this._mType[i] = TYPE_CODE[m.type] ?? 0;
      this._mMass[i] = this.PVOL * m.rho;
      this._mE[i]    = m.E;
      this._mMu[i]   = m._mu;
      this._mLa[i]   = m._la;
      this._mCs[i]   = m.cScale;
      this._mVd[i]   = m.vdamp;
      this._mRho[i]  = m.rho;
    }

    this._initAir();
  }

  /* Seed a sparse, invisible air background that fills the domain.
     Air particles live at the FRONT of the particle array and are
     re-seeded after every reset so the medium is always present. */
  _initAir() {
    const step = this.DX * 2;         // one particle per 2³ cells — lightweight
    const lo = this.DX * 2, hi = (this.N - 2) * this.DX;
    for (let x = lo; x < hi; x += step) {
      for (let y = lo; y < hi; y += step) {
        for (let z = lo; z < hi; z += step) {
          if (this.nP >= this.MAX) return;
          const i = this.nP;
          this.px[i] = x; this.py[i] = y; this.pz[i] = z;
          this.pvx[i] = 0; this.pvy[i] = 0; this.pvz[i] = 0;
          this.pJ[i]  = 1.0; this.pMt[i] = 8;
          const o = i * 9;
          for (let c = 0; c < 9; c++) this.pC[o+c] = 0;
          this.pF[o]=1; this.pF[o+4]=1; this.pF[o+8]=1;
          this.nP++;
        }
      }
    }
    this._airCount = this.nP; // remember how many air particles we seeded
  }

  spawnBox(x0, y0, z0, x1, y1, z1, matId, ppc = 2) {
    const step = this.DX / ppc;
    const lo   = 1.5 * this.DX, hi = (this.N - 1.5) * this.DX;
    const jitter = step * 0.25;
    for (let x = x0; x < x1; x += step) {
      for (let y = y0; y < y1; y += step) {
        for (let z = z0; z < z1; z += step) {
          if (this.nP >= this.MAX) return;
          const i = this.nP;
          this.px[i] = Math.max(lo, Math.min(hi, x + (Math.random()-.5)*jitter));
          this.py[i] = Math.max(lo, Math.min(hi, y + (Math.random()-.5)*jitter));
          this.pz[i] = Math.max(lo, Math.min(hi, z + (Math.random()-.5)*jitter));
          this.pvx[i]=0; this.pvy[i]=0; this.pvz[i]=0;
          this.pJ[i]=1.0; this.pMt[i]=matId;
          const o = i*9;
          for (let c=0;c<9;c++) this.pC[o+c]=0;
          this.pF[o]=1;this.pF[o+4]=1;this.pF[o+8]=1;
          this.nP++;
        }
      }
    }
  }

  reset() {
    this.nP = 0;
    this._initAir();
  }

  tick() {
    const DT = 1 / 60 / this.sub;
    for (let s = 0; s < this.sub; s++) this._step(DT);
  }

  _step(DT) {
    const { N, INV, DX, PVOL, DINV,
            px, py, pz, pvx, pvy, pvz, pC, pF, pJ, pMt, nP,
            gM, gVx, gVy, gVz, _WX, _WY, _WZ,
            _mType, _mMass, _mE, _mMu, _mLa, _mCs, _mVd, _mRho } = this;
    const coef = -DT * PVOL * DINV;

    /* ── RESET ALL FIELD GRIDS ─────────────────────────────────── */
    for (let f = 0; f < 3; f++) {
      gM[f].fill(0); gVx[f].fill(0); gVy[f].fill(0); gVz[f].fill(0);
    }

    /* ── P2G — particle → its field's grid ─────────────────────── */
    for (let p = 0; p < nP; p++) {
      const mt   = pMt[p];
      const type = _mType[mt];
      const fl   = MAT_FIELD[mt];          // which velocity field
      const pm   = _mMass[mt];
      const fo   = p * 9;
      const gMf  = gM[fl], gVxf = gVx[fl], gVyf = gVy[fl], gVzf = gVz[fl];

      let A0,A1,A2,A3,A4,A5,A6,A7,A8;
      const C0=pC[fo],C1=pC[fo+1],C2=pC[fo+2];
      const C3=pC[fo+3],C4=pC[fo+4],C5=pC[fo+5];
      const C6=pC[fo+6],C7=pC[fo+7],C8=pC[fo+8];

      if (type === 2) {
        const f0=pF[fo],f1=pF[fo+1],f2=pF[fo+2],
              f3=pF[fo+3],f4=pF[fo+4],f5=pF[fo+5],
              f6=pF[fo+6],f7=pF[fo+7],f8=pF[fo+8];
        const J = f0*(f4*f8-f5*f7) - f1*(f3*f8-f5*f6) + f2*(f3*f7-f4*f6);
        polarR(pF, fo);
        const m0=f0-_R[0],m1=f1-_R[1],m2=f2-_R[2],
              m3=f3-_R[3],m4=f4-_R[4],m5=f5-_R[5],
              m6=f6-_R[6],m7=f7-_R[7],m8=f8-_R[8];
        const p0=m0*f0+m1*f1+m2*f2,p1=m0*f3+m1*f4+m2*f5,p2=m0*f6+m1*f7+m2*f8;
        const p3=m3*f0+m4*f1+m5*f2,p4=m3*f3+m4*f4+m5*f5,p5=m3*f6+m4*f7+m5*f8;
        const p6=m6*f0+m7*f1+m8*f2,p7=m6*f3+m7*f4+m8*f5,p8=m6*f6+m7*f7+m8*f8;
        const mu2 = 2*_mMu[mt], lj = _mLa[mt]*J*(J-1);
        A0=coef*(mu2*p0+lj)+pm*C0; A1=coef*(mu2*p1)+pm*C1; A2=coef*(mu2*p2)+pm*C2;
        A3=coef*(mu2*p3)+pm*C3;    A4=coef*(mu2*p4+lj)+pm*C4; A5=coef*(mu2*p5)+pm*C5;
        A6=coef*(mu2*p6)+pm*C6;    A7=coef*(mu2*p7)+pm*C7; A8=coef*(mu2*p8+lj)+pm*C8;
      } else {
        const J = pJ[p];
        let press = _mE[mt] * (J - 1);
        if (press > 0) press = 0;
        const s = coef * press;
        A0=s+pm*C0; A1=pm*C1; A2=pm*C2;
        A3=pm*C3;   A4=s+pm*C4; A5=pm*C5;
        A6=pm*C6;   A7=pm*C7; A8=s+pm*C8;
      }

      const xp=px[p],yp=py[p],zp=pz[p];
      const bx=(xp*INV-.5)|0, by=(yp*INV-.5)|0, bz=(zp*INV-.5)|0;
      const fx=xp*INV-bx, fy=yp*INV-by, fz=zp*INV-bz;
      _WX[0]=.5*(1.5-fx)**2; _WX[1]=.75-(fx-1)**2; _WX[2]=.5*(fx-.5)**2;
      _WY[0]=.5*(1.5-fy)**2; _WY[1]=.75-(fy-1)**2; _WY[2]=.5*(fy-.5)**2;
      _WZ[0]=.5*(1.5-fz)**2; _WZ[1]=.75-(fz-1)**2; _WZ[2]=.5*(fz-.5)**2;

      const mvx=pm*pvx[p], mvy=pm*pvy[p], mvz=pm*pvz[p];

      for (let i=0;i<3;i++) {
        const gi=bx+i; if(gi<0||gi>=N) continue;
        const dpx=(i-fx)*DX;
        for (let j=0;j<3;j++) {
          const gj=by+j; if(gj<0||gj>=N) continue;
          const dpy=(j-fy)*DX;
          const wij=_WX[i]*_WY[j];
          for (let k=0;k<3;k++) {
            const gk=bz+k; if(gk<0||gk>=N) continue;
            const dpz=(k-fz)*DX, w=wij*_WZ[k];
            const idx=(gi*N+gj)*N+gk;
            gMf[idx]  += w*pm;
            gVxf[idx] += w*(mvx + A0*dpx+A1*dpy+A2*dpz);
            gVyf[idx] += w*(mvy + A3*dpx+A4*dpy+A5*dpz);
            gVzf[idx] += w*(mvz + A6*dpx+A7*dpy+A8*dpz);
          }
        }
      }
    }

    /* ── GRID UPDATE — per field, with per-field gravity ────────
       Field 2 (air) has zero gravity: air stays distributed as a
       background medium rather than pooling at the floor.         */
    const g = this.gravity;
    const FG = [g, g, 0];              // gravity per field
    for (let f = 0; f < 3; f++) {
      const gMf=gM[f], gVxf=gVx[f], gVyf=gVy[f], gVzf=gVz[f];
      const gf = FG[f];
      for (let idx = 0; idx < this.N3; idx++) {
        const mass = gMf[idx];
        if (mass < 1e-12) continue;
        const im = 1/mass;
        const k=idx%N, j=((idx/N)|0)%N, i=(idx/(N*N))|0;
        let vx=gVxf[idx]*im, vy=gVyf[idx]*im+DT*gf, vz=gVzf[idx]*im;
        if (i<2   && vx<0) vx=0; if (i>N-3 && vx>0) vx=0;
        if (j<2   && vy<0) vy=0; if (j>N-3 && vy>0) vy=0;
        if (k<2   && vz<0) vz=0; if (k>N-3 && vz>0) vz=0;
        if (j<2) { vx*=.90; vz*=.90; }
        gVxf[idx]=vx; gVyf[idx]=vy; gVzf[idx]=vz;
      }
    }

    /* ── INTER-FIELD CONTACT ────────────────────────────────────
       For every cell where two fields both have mass, exchange
       momentum proportional to the velocity difference × the
       lighter field's mass × the coupling coefficient.
       Newton's 3rd law: equal and opposite impulses applied to
       both fields. This decouples sticking (water no longer drags
       ice) while still letting ice float via pressure contact, and
       gives the air field real resistance to moving solids.       */
    {
      const gM0=gM[0],gM1=gM[1],gM2=gM[2];
      const gVx0=gVx[0],gVy0=gVy[0],gVz0=gVz[0];
      const gVx1=gVx[1],gVy1=gVy[1],gVz1=gVz[1];
      const gVx2=gVx[2],gVy2=gVy[2],gVz2=gVz[2];

      for (let idx = 0; idx < this.N3; idx++) {
        const m0=gM0[idx], m1=gM1[idx], m2=gM2[idx];

        // liquid ↔ solid
        if (m0>1e-12 && m1>1e-12) {
          const c=COUP[0][1]*Math.min(m0,m1);
          const ix=(gVx0[idx]-gVx1[idx])*c, iy=(gVy0[idx]-gVy1[idx])*c, iz=(gVz0[idx]-gVz1[idx])*c;
          gVx0[idx]-=ix/m0; gVy0[idx]-=iy/m0; gVz0[idx]-=iz/m0;
          gVx1[idx]+=ix/m1; gVy1[idx]+=iy/m1; gVz1[idx]+=iz/m1;
        }
        // liquid ↔ air
        if (m0>1e-12 && m2>1e-12) {
          const c=COUP[0][2]*Math.min(m0,m2);
          const ix=(gVx0[idx]-gVx2[idx])*c, iy=(gVy0[idx]-gVy2[idx])*c, iz=(gVz0[idx]-gVz2[idx])*c;
          gVx0[idx]-=ix/m0; gVy0[idx]-=iy/m0; gVz0[idx]-=iz/m0;
          gVx2[idx]+=ix/m2; gVy2[idx]+=iy/m2; gVz2[idx]+=iz/m2;
        }
        // solid ↔ air
        if (m1>1e-12 && m2>1e-12) {
          const c=COUP[1][2]*Math.min(m1,m2);
          const ix=(gVx1[idx]-gVx2[idx])*c, iy=(gVy1[idx]-gVy2[idx])*c, iz=(gVz1[idx]-gVz2[idx])*c;
          gVx1[idx]-=ix/m1; gVy1[idx]-=iy/m1; gVz1[idx]-=iz/m1;
          gVx2[idx]+=ix/m2; gVy2[idx]+=iy/m2; gVz2[idx]+=iz/m2;
        }
      }
    }

    /* ── G2P — each particle gathers from its own field ─────────── */
    const lo = 1.5*DX, hi = (N-1.5)*DX;

    for (let p = 0; p < nP; p++) {
      const mt   = pMt[p];
      const type = _mType[mt];
      const fl   = MAT_FIELD[mt];
      const fo   = p * 9;
      const gVxf = gVx[fl], gVyf = gVy[fl], gVzf = gVz[fl];

      const xp=px[p],yp=py[p],zp=pz[p];
      const bx=(xp*INV-.5)|0, by=(yp*INV-.5)|0, bz=(zp*INV-.5)|0;
      const fx=xp*INV-bx, fy=yp*INV-by, fz=zp*INV-bz;
      _WX[0]=.5*(1.5-fx)**2; _WX[1]=.75-(fx-1)**2; _WX[2]=.5*(fx-.5)**2;
      _WY[0]=.5*(1.5-fy)**2; _WY[1]=.75-(fy-1)**2; _WY[2]=.5*(fy-.5)**2;
      _WZ[0]=.5*(1.5-fz)**2; _WZ[1]=.75-(fz-1)**2; _WZ[2]=.5*(fz-.5)**2;

      let nvx=0, nvy=0, nvz=0;
      let C0=0,C1=0,C2=0,C3=0,C4=0,C5=0,C6=0,C7=0,C8=0;

      for (let i=0;i<3;i++) {
        const gi=bx+i; if(gi<0||gi>=N) continue;
        const dpx=(i-fx)*DX;
        for (let j=0;j<3;j++) {
          const gj=by+j; if(gj<0||gj>=N) continue;
          const dpy=(j-fy)*DX;
          const wij=_WX[i]*_WY[j];
          for (let k=0;k<3;k++) {
            const gk=bz+k; if(gk<0||gk>=N) continue;
            const dpz=(k-fz)*DX, w=wij*_WZ[k];
            const idx=(gi*N+gj)*N+gk;
            const gvx=gVxf[idx], gvy=gVyf[idx], gvz=gVzf[idx];
            nvx+=w*gvx; nvy+=w*gvy; nvz+=w*gvz;
            const sc=w*DINV;
            C0+=sc*gvx*dpx; C1+=sc*gvx*dpy; C2+=sc*gvx*dpz;
            C3+=sc*gvy*dpx; C4+=sc*gvy*dpy; C5+=sc*gvy*dpz;
            C6+=sc*gvz*dpx; C7+=sc*gvz*dpy; C8+=sc*gvz*dpz;
          }
        }
      }

      /* Buoyancy within the liquid field: lighter fluid rises through
         denser fluid (water through lava, etc.).  Solid and air fields
         don't need this — solids float via cross-field contact pressure,
         air has zero gravity and needs no upward nudge.               */
      if (fl === 0 && type === 0) {
        const ax=bx+1, az=bz+1;
        if (ax>=0 && ax<N && az>=0 && az<N) {
          const colBase = ax*N*N + az;
          const myRho   = _mRho[mt];
          const yTop    = Math.min(N-1, by+2+4);
          let maxAbove  = 0;
          for (let yy=by+2; yy<=yTop; yy++) {
            const r = gM[0][colBase+yy*N] / (8*PVOL);
            if (r > maxAbove) maxAbove = r;
          }
          if (maxAbove > myRho*1.3) {
            const rise = Math.min(Math.sqrt(maxAbove/myRho-1)*0.5, 2.5);
            if (nvy < rise) nvy = rise;
          }
        }
      }

      const vd = _mVd[mt];
      pvx[p]=nvx*vd; pvy[p]=nvy*vd; pvz[p]=nvz*vd;

      const cs = _mCs[mt];
      C0*=cs;C1*=cs;C2*=cs;C3*=cs;C4*=cs;C5*=cs;C6*=cs;C7*=cs;C8*=cs;
      pC[fo]=C0;pC[fo+1]=C1;pC[fo+2]=C2;
      pC[fo+3]=C3;pC[fo+4]=C4;pC[fo+5]=C5;
      pC[fo+6]=C6;pC[fo+7]=C7;pC[fo+8]=C8;

      if (type === 2) {
        const a0=1+DT*C0,a1=DT*C1,a2=DT*C2,a3=DT*C3,a4=1+DT*C4,a5=DT*C5,a6=DT*C6,a7=DT*C7,a8=1+DT*C8;
        const f0=pF[fo],f1=pF[fo+1],f2=pF[fo+2],f3=pF[fo+3],f4=pF[fo+4],
              f5=pF[fo+5],f6=pF[fo+6],f7=pF[fo+7],f8=pF[fo+8];
        pF[fo]  =a0*f0+a1*f3+a2*f6; pF[fo+1]=a0*f1+a1*f4+a2*f7; pF[fo+2]=a0*f2+a1*f5+a2*f8;
        pF[fo+3]=a3*f0+a4*f3+a5*f6; pF[fo+4]=a3*f1+a4*f4+a5*f7; pF[fo+5]=a3*f2+a4*f5+a5*f8;
        pF[fo+6]=a6*f0+a7*f3+a8*f6; pF[fo+7]=a6*f1+a7*f4+a8*f7; pF[fo+8]=a6*f2+a7*f5+a8*f8;
      } else {
        let J = pJ[p]*(1+DT*(C0+C4+C8));
        if (type===1 && J>1) J=1;
        pJ[p] = J<.6?.6:J>1.5?1.5:J;
      }

      let npx=xp+DT*nvx, npy=yp+DT*nvy, npz=zp+DT*nvz;
      px[p]=npx<lo?lo:npx>hi?hi:npx;
      py[p]=npy<lo?lo:npy>hi?hi:npy;
      pz[p]=npz<lo?lo:npz>hi?hi:npz;
    }
  }
}
