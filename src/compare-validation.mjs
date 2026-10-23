import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, lstatSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, parse, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat, safePath, sha256 } from './contracts.mjs';

const validation = fileURLToPath(new URL('../validation/', import.meta.url));
const pinBytes = readFileSync(join(validation, 'internal-compare-pin.json'));
const pin = JSON.parse(pinBytes);
const cap = 64 * 1024 * 1024;

function noSymlinks(path) {
  const full = resolve(path), root = parse(full).root;
  let at = root;
  for (const part of full.slice(root.length).split('/').filter(Boolean)) {
    at = join(at, part);
    requireThat(!lstatSync(at).isSymbolicLink(), 'Validation paths cannot traverse symbolic links');
  }
  return full;
}
function bytes(path) {
  const full = noSymlinks(path), stat = lstatSync(full);
  requireThat(stat.isFile() && stat.size > 0 && stat.size <= cap, 'Validation input must be a bounded regular file');
  const value = readFileSync(full);
  requireThat(value.length > 0 && value.length <= cap, 'Validation input exceeded byte limit');
  return value;
}
function listFiles(root, prefix = '') {
  const result = [];
  for (const item of readdirSync(join(root, prefix), { withFileTypes: true })) {
    requireThat(!item.isSymbolicLink(), 'Pinned report tree cannot contain symbolic links');
    const path = prefix ? prefix + '/' + item.name : item.name;
    if (item.isDirectory()) result.push(...listFiles(root, path));
    else { requireThat(item.isFile(), 'Pinned report tree must contain regular files'); result.push(path); }
  }
  return result.sort();
}

// This exception was explicitly authorized for validation. It does not create
// a public Pulse export, install a fallback or admit other package versions.
export function verifyPinnedInternals(roots) {
  requireThat(pin.schemaVersion === 'pulse.report-action.internal-compare-pin.v1' && pin.purpose === 'validation-only', 'Invalid validation pin');
  for (const [name, packageName] of [['cli', '@pulse-compute/cli'], ['contracts', '@pulse-compute/wasm-contracts']]) {
    noSymlinks(roots[name]);
    const pkg = JSON.parse(bytes(join(roots[name], 'package.json')));
    requireThat(pkg.name === packageName && pkg.version === pin.packageVersion, 'Unsupported validation package version or identity');
  }
  for (const entry of pin.files) {
    safePath(entry.path);
    requireThat(Object.hasOwn(roots, entry.root), 'Unknown pinned package root');
    requireThat(sha256(bytes(join(roots[entry.root], entry.path))) === entry.sha256, `Validation internal digest differs: ${entry.root}/${entry.path}`);
  }
  const expected = pin.files.filter(f => f.root === 'cli' && f.path.startsWith('src/internal/report/'))
    .map(f => f.path.slice('src/internal/report/'.length)).sort();
  requireThat(JSON.stringify(listFiles(join(roots.cli, 'src/internal/report'))) === JSON.stringify(expected), 'Validation report inventory differs');
  return { adapter: 'internal-beta10-validation', packageVersion: pin.packageVersion,
    sourceRevision: pin.sourceRevision, pinSha256: sha256(pinBytes), upstreamIssue: pin.upstreamIssue };
}

export function loadInternalComparison({ allowInternal = false } = {}) {
  requireThat(allowInternal === true, 'Internal comparison requires explicit validation opt-in');
  const req = createRequire(join(validation, 'package.json'));
  let entry;
  try { entry = req.resolve('@pulse-compute/cli'); }
  catch { throw new Error('Install pinned validation dependencies: npm ci --prefix validation --ignore-scripts'); }
  const cli = dirname(dirname(entry)), local = createRequire(join(cli, 'package.json'));
  const contractEntry = local.resolve('@pulse-compute/wasm-contracts/path');
  const roots = { cli, contracts: dirname(dirname(contractEntry)) };
  const prefix = realpathSync(join(validation, 'node_modules')) + '/';
  requireThat(Object.values(roots).every(root => resolve(root).startsWith(prefix)), 'Validation packages must come from isolated validation/node_modules');
  const identity = verifyPinnedInternals(roots);
  requireThat(entry === join(cli, 'src/index.js') && contractEntry === join(roots.contracts, 'src/path.js'), 'Validation entrypoint differs');
  // All report files and the only non-builtin external dependency are checked
  // before requiring code. No project config or project dependencies are loaded.
  const { parseCapsule, createCapsule, serializeCapsule } = local('./src/internal/report/capsule.js');
  const { compareCapsules, serializeComparison, parseComparison } = local('./src/internal/report/comparison.js');
  const { renderComparison } = local('./src/internal/report/comparison-viewer.js');
  return { parseCapsule, createCapsule, serializeCapsule, compareCapsules, serializeComparison, parseComparison, renderComparison, identity };
}

export function compareForValidation({ before, after, output, allowInternal = false }) {
  const api = loadInternalComparison({ allowInternal });
  const beforeBytes = bytes(before), afterBytes = bytes(after);
  const comparison = api.compareCapsules(api.parseCapsule(beforeBytes), api.parseCapsule(afterBytes));
  const json = api.serializeComparison(comparison), html = api.renderComparison(comparison);
  requireThat(Buffer.byteLength(json) <= cap && Buffer.byteLength(html) <= cap, 'Validation output exceeds byte limit');
  const receipt = { schemaVersion: 'pulse.report-action.compare-shim-receipt.v1', purpose: 'validation-only',
    ...api.identity, inputs: { beforeSha256: sha256(beforeBytes), afterSha256: sha256(afterBytes) },
    capsuleHashes: { before: comparison.sources.before.capsuleHash, after: comparison.sources.after.capsuleHash },
    comparisonHash: comparison.comparisonHash, compatibility: comparison.compatibility.status,
    files: [{ path: 'compare.json', sha256: sha256(json), bytes: Buffer.byteLength(json) },
      { path: 'compare.html', sha256: sha256(html), bytes: Buffer.byteLength(html) }] };
  const dir = resolve(output);
  noSymlinks(dirname(dir));
  // A fresh directory avoids overwriting report inputs or a prior validation.
  // It is created only after both inputs and all renderer outputs validate.
  mkdirSync(dir);
  writeFileSync(join(dir, 'compare.json'), json, { flag: 'wx' });
  writeFileSync(join(dir, 'compare.html'), html, { flag: 'wx' });
  writeFileSync(join(dir, 'compare-shim-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [optIn, before, after, output, ...extra] = process.argv.slice(2);
  requireThat(optIn === '--allow-internal-beta10' && before && after && output && !extra.length,
    'Usage: node src/compare-validation.mjs --allow-internal-beta10 <before.json> <after.json> <new-output-directory>');
  console.error('Validation only: using pinned Pulse beta.10 internals pending pulse#503.');
  console.log(JSON.stringify(compareForValidation({ before, after, output, allowInternal: true }), null, 2));
}
