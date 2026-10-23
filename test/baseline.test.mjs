import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealBaseline, baselineArtifactName, validateBaselineBinding, selectBaseline, verifyBaseline } from '../src/baseline-evidence.mjs';
import { recoverRetained, downloadReports, githubClient } from '../src/baseline.mjs';
import { execute } from '../src/capture.mjs';
import { sha256 } from '../src/contracts.mjs';
const revision = 'a'.repeat(40), now = Date.parse('2026-10-23T00:00:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'head.json'), '{}'); writeFileSync(join(root, 'head.html'), '<html>');
  const manifest = sealBaseline(root, { repository: 'owner/repo', headRevision: revision, project: { root: '.' },
    recipe: { profile: 'ci', provider: 'node', target: 'native', pulseVersion: '1.0.0-beta.10', lockSha256: 'b'.repeat(64), executionSha256: 'c'.repeat(64) },
    workflow: { id: 8, path: '.github/workflows/pulse.yml', revision }, run: { id: 10, attempt: 2, event: 'push' }, branch: 'main' },
  [{ role: 'head-json', path: 'head.json' }, { role: 'head-html', path: 'head.html' }]);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest)); writeFileSync(join(root, 'capture.json'), '{}');
  const run = { id: 10, run_attempt: 2, workflow_id: 8, path: manifest.workflow.path, head_sha: revision, head_branch: 'main',
    status: 'completed', conclusion: 'success', event: 'push', repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' } };
  const expected = { repository: 'owner/repo', revision, branch: 'main', projectRoot: '.', recipe: manifest.recipe, workflowId: 8, workflowPath: run.path };
  const artifact = { id: 20, name: baselineArtifactName(manifest), expired: false, expires_at: '2027-01-01', digest: 'sha256:' + 'd'.repeat(64), workflow_run: { id: 10, head_sha: revision } };
  return { root, manifest, run, artifact, expected, now };
}
function zip(f, entries) {
  const file = join(f.root, 'bundle.zip');
  execute('python3', ['-c', `import zipfile,sys,json\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for n,v in json.loads(sys.argv[2]): z.writestr(n,v)`, file,
    JSON.stringify(entries ?? ['head.json', 'head.html', 'manifest.json', 'capture.json'].map(n => [n, readFileSync(join(f.root, n), 'utf8')]))]);
  return readFileSync(file);
}
test('approved-push baseline binds exact origin, recipe, source, workflow, retention and rerun attempt', t => {
  const f = fixture(t); assert.equal(validateBaselineBinding(f).artifactId, 20); verifyBaseline(f.root, f.manifest);
  for (const mutate of [x => x.run.event = 'pull_request', x => x.run.head_branch = 'other', x => x.run.head_sha = 'e'.repeat(40),
    x => x.run.repository.full_name = 'other/repo', x => x.run.head_repository.full_name = 'fork/repo', x => x.run.workflow_id++, x => x.run.path += 'x',
    x => x.run.run_attempt++, x => x.manifest.run.attempt--, x => x.manifest.revision = 'e'.repeat(40), x => x.manifest.project.root = 'app',
    x => x.manifest.recipe.pulseVersion = '1.0.0-beta.9', x => x.manifest.recipe.executionSha256 = 'e'.repeat(64),
    x => x.artifact.digest = null, x => x.artifact.workflow_run.id++, x => x.artifact.expired = true, x => x.artifact.expires_at = '2020-01-01']) {
    const x = structuredClone(f); mutate(x); assert.throws(() => validateBaselineBinding(x));
  }
});
test('selection rejects ambiguity and excludes expired, wrong-recipe and old-attempt archives', t => {
  const f = fixture(t), c = { run: f.run, artifact: f.artifact };
  assert.equal(selectBaseline([c], f.expected, now), c);
  assert.throws(() => selectBaseline([c, structuredClone(c)], f.expected, now), /Ambiguous/);
  for (const mutate of [c => c.artifact.expired = true, c => c.artifact.name = c.artifact.name.replace(/-2$/, '-1'), c => c.run.head_sha = 'e'.repeat(40)]) {
    const x = structuredClone(c); mutate(x); assert.equal(selectBaseline([x], f.expected, now), null);
  }
  assert.equal(selectBaseline([c], { ...f.expected, recipe: { ...f.expected.recipe, lockSha256: 'e'.repeat(64) } }, now), null);
});
test('retained recovery verifies ZIP then inventory, report hashes and latest authenticated attempt', async t => {
  const f = fixture(t), bytes = zip(f); f.artifact.digest = 'sha256:' + sha256(bytes);
  let latest = f.run;
  const api = { json: async p => p.includes('/workflows/') ? { workflow_runs: [f.run] } : p.endsWith('/artifacts?per_page=100&page=1') ? { artifacts: [f.artifact] } : latest,
    archive: async id => { assert.equal(id, 20); return bytes; } };
  const result = await recoverRetained({ api, expected: f.expected, output: join(f.root, 'extracted'), now });
  assert.equal(result.status, 'retained'); assert.equal(result.binding.attempt, 2);
  latest = { ...f.run, run_attempt: 3 };
  await assert.rejects(recoverRetained({ api, expected: f.expected, output: join(f.root, 'rerun'), now }), /changed during lookup/);
  writeFileSync(join(f.root, 'extracted/head.json'), 'changed'); assert.throws(() => verifyBaseline(join(f.root, 'extracted'), f.manifest), /bytes differ/);
});
test('missing or expired evidence rebuilds; digest mismatch fails before extraction', async t => {
  const f = fixture(t), api = { json: async p => p.includes('/workflows/') ? { workflow_runs: [f.run] } : { artifacts: [{ ...f.artifact, expired: true }] } };
  assert.equal((await recoverRetained({ api, expected: f.expected, output: join(f.root, 'absent'), now })).status, 'rebuild');
  await assert.rejects(downloadReports({ api: { archive: async () => Buffer.from('bad') }, artifact: f.artifact, output: join(f.root, 'unsafe'), mode: 'baseline' }), /digest mismatch/);
  assert.equal(existsSync(join(f.root, 'unsafe')), false);
});
test('ZIP traversal, duplicate entries and unexpected files reject before opening report paths', async t => {
  for (const names of [['../head.json', 'head.html', 'manifest.json', 'capture.json'], ['head.json', 'head.json', 'manifest.json', 'capture.json'], ['head.json', 'head.html', 'manifest.json', 'source.js']]) {
    const f = fixture(t), bytes = zip(f, names.map(n => [n, '{}']));
    await assert.rejects(downloadReports({ api: { archive: async () => bytes }, artifact: { id: 20, digest: 'sha256:' + sha256(bytes) }, output: join(f.root, 'reject'), mode: 'baseline' }));
  }
});
test('signed archive redirect never receives the GitHub token', async () => {
  const calls = [], api = githubClient('owner/repo', 'private-token', async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example/archive' } }) : new Response('archive');
  });
  assert.equal((await api.archive(20)).toString(), 'archive'); assert.equal(calls[1].options.headers, undefined);
  assert.match(calls[0].options.headers.Authorization, /private-token/);
});
