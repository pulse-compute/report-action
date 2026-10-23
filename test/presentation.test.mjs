import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stagePresentations, presentationName } from '../src/presentation.mjs';
import { sealBundle, artifactName } from '../src/evidence.mjs';
import { sha256 } from '../src/contracts.mjs';
const sha = 'a'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'report-presentation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle'); mkdirSync(bundle);
  writeFileSync(join(bundle, 'head.json'), '{}');
  const html = '<!doctype html><script>throw new Error("must not execute")</script>';
  writeFileSync(join(bundle, 'head.html'), html);
  const manifest = sealBundle(bundle, { repository: 'owner/repo', pullRequest: 1, targetBaseRevision: sha, baselineRevision: sha, headRevision: sha,
    project: { root: '.' }, recipe: { profile: 'ci', provider: 'node', target: 'native', pulseVersion: '1.0.0-beta.10', lockSha256: sha256('lock') },
    workflow: { path: '.github/workflows/pulse.yml', revision: sha }, run: { id: 1, attempt: 1, event: 'pull_request' },
    baseline: { status: 'unavailable', revision: sha, reason: 'not-requested' } }, [{ role: 'head-json', path: 'head.json' }, { role: 'head-html', path: 'head.html' }]);
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
  const capture = { status: 'captured', artifactName: artifactName(manifest) };
  writeFileSync(join(bundle, 'capture.json'), JSON.stringify(capture));
  return { root, bundle, html, capture };
}
test('standalone staging copies only verified HTML bytes and preserves the evidence bundle', t => {
  const f = fixture(t), before = readdirSync(f.bundle);
  const result = stagePresentations({ bundle: f.bundle, output: join(f.root, 'views') });
  assert.equal(readFileSync(result.report, 'utf8'), f.html);
  assert.deepEqual(readdirSync(f.bundle), before);
  assert.deepEqual(readdirSync(join(f.root, 'views')), [presentationName(f.capture.artifactName, 'report')]);
  writeFileSync(join(f.bundle, 'head.html'), 'tampered');
  assert.throws(() => stagePresentations({ bundle: f.bundle, output: join(f.root, 'bad') }), /bytes differ/);
});
test('failed captures and unavailable comparisons do not invent an HTML presentation', t => {
  const f = fixture(t);
  writeFileSync(join(f.bundle, 'capture.json'), JSON.stringify({ status: 'failed' }));
  assert.deepEqual(stagePresentations({ bundle: f.bundle, output: join(f.root, 'failed') }), {});
  writeFileSync(join(f.bundle, 'capture.json'), JSON.stringify({ ...f.capture, comparison: true }));
  assert.deepEqual(stagePresentations({ bundle: f.bundle, output: join(f.root, 'unavailable') }), {});
});
test('presentation filenames are unique across recipes/projects/runs/attempts and reject unsafe names', () => {
  const names = ['pulse-report-a-1-1-1', 'pulse-report-b-1-1-1', 'pulse-report-a-2-1-1', 'pulse-report-a-1-2-1', 'pulse-report-a-1-1-2'];
  assert.equal(new Set(names.map(n => presentationName(n, 'report'))).size, names.length);
  assert.equal(presentationName(names[0] + '-comparison', 'compare'), names[0] + '-compare.html');
  assert.throws(() => presentationName('../escape', 'report'));
  assert.throws(() => presentationName(names[0], 'unknown'));
});
