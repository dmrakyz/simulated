/**
 * Runs every headless LBM test suite in sequence. Exits non-zero on any failure.
 * Usage: node test/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['syntax.test.mjs', 'lbm-geometry.test.mjs', 'lbm-solver.test.mjs', 'lbm-airfoil.test.mjs', 'lbm-multilevel.test.mjs', 'flight-model.test.mjs', 'flight-stability.test.mjs'];

let failed = 0;
for (const s of suites) {
  console.log(`\n══════ ${s} ══════`);
  const r = spawnSync(process.execPath, [join(here, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(`\n${failed === 0 ? '✓ ALL SUITES PASS' : `✗ ${failed} SUITE(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
