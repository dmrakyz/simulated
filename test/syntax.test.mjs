/**
 * Syntax-check every browser JS file with `node --check`.
 *
 * The unit suites only import the headless math modules, so a parse error in a
 * browser-only entry point (main.js, builder.js, the renderers — none of which
 * Node ever loads) sails straight through to the device, where it silently
 * breaks the whole module graph and the app hangs on the loading screen.
 * This catches that class of bug (e.g. a duplicate `const` declaration) in CI.
 *
 * Run: node test/syntax.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const jsRoot = join(root, 'js');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

let passed = 0, failed = 0;
console.log('\n[syntax] every browser JS file parses');
for (const file of walk(jsRoot).sort()) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const rel = relative(root, file);
  if (r.status === 0) { passed++; console.log(`  ✓ ${rel}`); }
  else {
    failed++;
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' | ');
    console.error(`  ✗ ${rel}  ${msg}`);
  }
}

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
