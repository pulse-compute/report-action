import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareForValidation, loadInternalComparison, verifyPinnedInternals } from '../../src/compare-validation.mjs';
import { sha256 } from '../../src/contracts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const before = join(root, 'fixtures/before.json'), after = join(root, 'fixtures/after.json');
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-compare-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('internal adapter requires explicit opt-in', () => {
  assert.throws(() => loadInternalComparison(), /explicit validation opt-in/);
  assert.throws(() => loadInternalComparison({ allowInternal: 'true' }), /explicit validation opt-in/);
});
test('real retained reports produce shared-engine JSON and offline HTML without rewriting input provenance', t => {
  const dir = temporary(t), output = join(dir, 'comparison');
  const inputs = [readFileSync(before), readFileSync(after)];
  const receipt = compareForValidation({ before, after, output, allowInternal: true });
  const api = loadInternalComparison({ allowInternal: true });
  const comparison = api.parseComparison(readFileSync(join(output, 'compare.json')));
  const html = readFileSync(join(output, 'compare.html'), 'utf8');
  const embedded = html.match(/<script id="pulse-comparison-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(api.serializeComparison(api.parseComparison(embedded)), api.serializeComparison(comparison));
  assert.equal(html, api.renderComparison(comparison));
  assert.deepEqual(comparison.comparisonHash, receipt.comparisonHash);
  assert.equal(receipt.purpose, 'validation-only');
  assert.equal(receipt.adapter, 'internal-beta10-validation');
  assert.equal(receipt.compatibility, 'different-build');
  assert.equal(comparison.sources.before.producer.pulseVersion, '1.0.0-beta.9');
  assert.equal(comparison.sources.after.producer.pulseVersion, '1.0.0-beta.10');
  assert.equal(comparison.sources.before.provenance.revision, null);
  assert.equal(comparison.sources.after.provenance.revision, null);
  assert.deepEqual(readFileSync(before), inputs[0]); assert.deepEqual(readFileSync(after), inputs[1]);
  for (const file of receipt.files) {
    const actual = readFileSync(join(output, file.path));
    assert.equal(actual.length, file.bytes); assert.equal(sha256(actual), file.sha256);
  }
});
test('identical capsule retains genuine zero deltas and shared-engine no-change result', t => {
  const dir = temporary(t), output = join(dir, 'same');
  const receipt = compareForValidation({ before: after, after, output, allowInternal: true });
  const api = loadInternalComparison({ allowInternal: true });
  const c = api.parseComparison(readFileSync(join(output, 'compare.json')));
  assert.equal(c.summary.artifactBytes.delta, 0); assert.deepEqual(c.sections, []);
  assert.deepEqual(c.metadataChanges, []);
  assert.equal(receipt.inputs.beforeSha256, receipt.inputs.afterSha256);
});
test('malformed and tampered capsules fail before creating outputs', t => {
  const dir = temporary(t), invalid = join(dir, 'invalid.json');
  for (const value of ['{}', '{bad-json', JSON.stringify({ ...JSON.parse(readFileSync(after)), capsuleHash: { algorithm: 'sha256', value: '0'.repeat(64) } })]) {
    writeFileSync(invalid, value);
    assert.throws(() => compareForValidation({ before: invalid, after, output: join(dir, 'rejected'), allowInternal: true }));
    assert.equal(existsSync(join(dir, 'rejected')), false);
  }
});
test('refuses input symlinks and existing output directories', t => {
  const dir = temporary(t), linked = join(dir, 'linked.json'); symlinkSync(after, linked);
  assert.throws(() => compareForValidation({ before: linked, after, output: join(dir, 'out'), allowInternal: true }), /symbolic links/);
  assert.throws(() => compareForValidation({ before, after, output: dir, allowInternal: true }), /EEXIST/);
});
test('version, implementation digest and report inventory changes reject before requiring code', t => {
  const dir = temporary(t), req = createRequire(join(root, 'package.json'));
  const cli = dirname(dirname(req.resolve('@pulse-compute/cli')));
  const contract = dirname(dirname(createRequire(join(cli, 'package.json')).resolve('@pulse-compute/wasm-contracts/path')));
  const roots = { cli: join(dir, 'cli'), contracts: join(dir, 'contracts') };
  mkdirSync(roots.cli); mkdirSync(roots.contracts);
  cpSync(join(cli, 'package.json'), join(roots.cli, 'package.json'));
  cpSync(join(cli, 'src/internal/report'), join(roots.cli, 'src/internal/report'), { recursive: true });
  mkdirSync(join(roots.contracts, 'src'));
  cpSync(join(contract, 'package.json'), join(roots.contracts, 'package.json'));
  cpSync(join(contract, 'src/path.js'), join(roots.contracts, 'src/path.js'));
  assert.equal(verifyPinnedInternals(roots).packageVersion, '1.0.0-beta.10');
  const manifest = join(roots.cli, 'package.json'), original = readFileSync(manifest);
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), version: '1.0.0-beta.11' }));
  assert.throws(() => verifyPinnedInternals(roots), /version/); writeFileSync(manifest, original);
  const code = join(roots.cli, 'src/internal/report/comparison.js'), source = readFileSync(code);
  writeFileSync(code, "throw new Error('untrusted module must not execute');");
  assert.throws(() => verifyPinnedInternals(roots), /digest differs/); writeFileSync(code, source);
  writeFileSync(join(roots.cli, 'src/internal/report/extra.js'), 'extra');
  assert.throws(() => verifyPinnedInternals(roots), /inventory differs/);
});
