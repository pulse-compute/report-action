import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealBundle, verifyBundle, validateManifest, validateArtifactBinding, artifactName } from '../src/evidence.mjs';

const sha = digit => digit.repeat(40);
function fixture(t, complete = true) {
  const root = mkdtempSync(join(tmpdir(), 'pulse-report-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { repository: 'owner/repo', pullRequest: 12,
    targetBaseRevision: sha('1'), baselineRevision: sha('2'), headRevision: sha('3'),
    project: { root: 'apps/my app' }, recipe: { profile: 'production', provider: 'fastly', target: 'native', pulseVersion: '1.0.0-beta.10', lockSha256: 'a'.repeat(64) },
    workflow: { path: '.github/workflows/pulse-reports.yml', revision: sha('4') }, run: { id: 123, attempt: 1, event: 'pull_request' },
    baseline: { status: complete ? 'available' : 'unavailable', revision: sha('2'), reason: complete ? null : 'new-project' } };
  const roles = complete ? ['head-json', 'head-html', 'base-json', 'base-html', 'compare-json', 'compare-html'] : ['head-json', 'head-html'];
  const files = roles.map(role => ({ role, path: role + (role.endsWith('json') ? '.json' : '.html') }));
  for (const file of files) writeFileSync(join(root, file.path), file.role.endsWith('json') ? '{}' : '<!doctype html>');
  const manifest = sealBundle(root, identity, files);
  const expected = { repository: 'owner/repo', headRepository: 'contributor/repo', pullRequest: 12,
    targetBaseRevision: sha('1'), baselineRevision: sha('2'), headRevision: sha('3'), projectRoot: 'apps/my app',
    workflowPath: identity.workflow.path, workflowRevision: sha('4'), runId: 123, attempt: 1, recipe: identity.recipe };
  const run = { id: 123, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request',
    repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'contributor/repo' }, head_sha: sha('3'), path: expected.workflowPath };
  const artifact = { id: 456, name: artifactName(manifest), expired: false, expires_at: '2027-01-01T00:00:00Z', digest: 'sha256:' + 'b'.repeat(64), workflow_run: { id: 123, head_sha: sha('3') } };
  return { root, identity, files, manifest, expected, run, artifact, now: Date.parse('2026-10-22T00:00:00Z') };
}
test('seals full inventory and detects changed report bytes', t => {
  const f = fixture(t); assert.equal(verifyBundle(f.root, f.manifest), f.manifest);
  writeFileSync(join(f.root, 'head-html.html'), '<changed>');
  assert.throws(() => verifyBundle(f.root, f.manifest), /bytes differ/);
});
test('unavailable baseline retains head report without inventing comparison', t => {
  const f = fixture(t, false); assert.equal(validateManifest(f.manifest).files.length, 2);
  const bad = structuredClone(f.manifest); bad.files.push({ ...bad.files[0], role: 'compare-json', path: 'compare.json' });
  assert.throws(() => validateManifest(bad), /Unavailable baseline/);
  bad.files.pop(); bad.baseline.reason = null; assert.throws(() => validateManifest(bad), /baseline reason/);
});
test('missing comparison, duplicate roles, bad revisions and project mismatches reject', t => {
  const f = fixture(t);
  for (const mutate of [m => m.files.pop(), m => m.files.push(m.files[0]), m => m.headRevision = 'main',
    m => m.project.id = 'wrong', m => m.recipe.target = 'javascript', m => m.files[0].path = '../escape.json']) {
    const m = structuredClone(f.manifest); mutate(m); assert.throws(() => validateManifest(m));
  }
});
test('symlink files and parent directories reject before upload', t => {
  const f = fixture(t, false); symlinkSync(join(f.root, 'head-json.json'), join(f.root, 'link.json'));
  assert.throws(() => sealBundle(f.root, f.identity, [{ role: 'head-json', path: 'link.json' }, f.files[1]]), /symlinks/);
  mkdirSync(join(f.root, 'real')); writeFileSync(join(f.root, 'real/a.json'), '{}'); symlinkSync(join(f.root, 'real'), join(f.root, 'linked'));
  assert.throws(() => sealBundle(f.root, f.identity, [{ role: 'head-json', path: 'linked/a.json' }, f.files[1]]), /symlinks/);
});
test('binding admits exact retained run, fork identity, recipe and attempt', t => {
  const f = fixture(t); const b = validateArtifactBinding(f);
  assert.equal(b.artifactId, 456); assert.equal(b.runId, 123);
  const reordered = { ...f.manifest, recipe: Object.fromEntries(Object.entries(f.manifest.recipe).reverse()) };
  assert.equal(artifactName(reordered), artifactName(f.manifest));
});
test('binding rejects wrong PR/head/base/project/recipe/workflow and superseded attempts', t => {
  const f = fixture(t);
  for (const mutate of [x => x.expected.pullRequest++, x => x.expected.headRevision = sha('5'),
    x => x.expected.baselineRevision = sha('5'), x => x.expected.targetBaseRevision = sha('5'),
    x => x.expected.projectRoot = 'other', x => x.expected.recipe.profile = 'development',
    x => x.run.run_attempt++, x => x.run.path = '.github/workflows/other.yml',
    x => x.run.head_repository.full_name = 'attacker/repo', x => x.run.conclusion = 'failure',
    x => x.manifest.workflow.revision = sha('5')]) {
    const x = structuredClone(f); mutate(x); assert.throws(() => validateArtifactBinding(x));
  }
});
test('binding rejects expired, ambiguous-name, digestless and unrelated artifacts', t => {
  const f = fixture(t);
  for (const mutate of [a => a.expired = true, a => a.expires_at = '2020-01-01', a => a.digest = null,
    a => a.name += '-old', a => a.workflow_run.id++, a => a.workflow_run.head_sha = sha('6'), a => a.id = 0]) {
    const x = structuredClone(f); mutate(x.artifact); assert.throws(() => validateArtifactBinding(x));
  }
});
