# Creature Aerodynamics — Adaptive Creature-Fitted Multi-Level LBM

A lattice-Boltzmann air simulation that fits itself to whatever creature you
build, so wings and fins develop real lift and drag in **SIMULATE** mode. It is
**additive**: the existing MPM particle world (WORLD / BUILD modes) is untouched.

## How it works

1. **Measure the creature** (`creature-bounds.js`) — axis-aligned bounding box
   plus the longest path through the body-part graph (two-pass BFS diameter).
2. **Fit a rectangular grid** (`grid-params.js`) — three nested, self-similar
   levels sized to the creature's actual shape, not a fixed cube:
   - **FAG** — fine, hugs the body (captures the wing surface)
   - **NFF** — `RATIO×` coarser/larger, the immediate wake
   - **CWG** — `RATIO²` coarser, the far field
   A thin snake → thin grid; a round blob → near-cube. Each level keeps a
   similar cell budget, so cost ≈ 3× one level while covering `RATIO²` more space.
3. **Solve** (`level.js`) — D3Q19 single-relaxation-time (BGK) lattice Boltzmann
   in the creature's **Galilean frame**: the body is stationary and the far
   field flows past at `−v_creature`. Velocity-clamped collision keeps it stable
   for arbitrarily fast creatures (Mach-stable at 1000 m/s — see tests).
4. **Obstacles** (`solid-mask.js`) — body parts are rasterized into FAG as solid
   cells with per-cell wall velocity, so moving (Ladd) bounce-back turns wing
   motion into a pressure field → net force.
5. **Orchestrate** (`multi-level.js`) — per-level substep schedule (10/5/3),
   smoothed Galilean inlet, and the net aerodynamic force in newtons.

## Backends

| Path | File | Status |
|------|------|--------|
| **CPU (default)** | `level.js` + `multi-level.js` | The tested reference solver. Runs in `lbm-worker.js` off the main thread, with a main-thread fallback in `aero-controller.js`. Always works. |
| **GPU (opt-in)** | `gpu-kernel.js` | Real WebGPU D3Q19 kernel mirroring the CPU numerics. **Gated** behind `isWebGPUAvailable()` and not yet wired into the live path — it can't be exercised by the headless tests, so keeping it opt-in means an undetected WGSL issue can never break the shipping feature. |

## Tests

Pure-Node, no browser/WebGPU required:

```
npm test          # runs all three suites (40 assertions)
```

- `lbm-geometry.test.mjs` — bounds, diameter, grid-level construction
- `lbm-solver.test.mjs` — mass conservation, quiescence, inlet flow, plate lift
- `lbm-multilevel.test.mjs` — schedule, Mach-stability at 1000 m/s, net force

## Wiring

`main.js` creates an `AeroController` + `FlowRenderer`. Entering SIMULATE mode
extracts the built creature (`AeroController.partsFromBuilder`), starts the sim,
shows flow lines, and displays the live aero force in the HUD. Leaving the mode
stops it. None of this runs in WORLD/BUILD.
