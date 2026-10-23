import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, execute } from '../src/capture.mjs';
import { discover } from '../src/discover.mjs';
import { verifyBundle } from '../src/evidence.mjs';
import { buildMatrix } from '../src/workflow.mjs';

const source = fileURLToPath(new URL('../fixtures/consumer/', import.meta.url));
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'pulse capture consumer ')), checkout = join(temp, 'repository');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  cpSync(source, checkout, { recursive: true, filter: name => !['node_modules', 'dist', 'reports'].includes(basename(name)) });
  const git = (...args) => execute('git', args, { cwd: checkout }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '-A'); git('commit', '-qm', 'consumer baseline'); const base = git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'src/index.ts'), readFileSync(join(checkout, 'src/index.ts'), 'utf8') + '\n// PR source change\n');
  git('add', '-A'); git('commit', '-qm', 'consumer PR'); const head = git('rev-parse', 'HEAD');
  const metadata = { repository: 'fixture/consumer', pullRequest: 1, runId: 123, attempt: 1, event: 'pull_request',
    workflowPath: '.github/workflows/pulse.yml', workflowRevision: head, toolingRevision: 'a'.repeat(40) };
  const discovery = discover({ cwd: checkout, base, head });
  // Changing the root project affects root; select nested explicitly via a
  // shared tracked lock change in the nested test below.
  return { temp, checkout, git, base, head, metadata, discovery };
}
test('real npm-installed beta.10 captures root and nested Native projects with explicit byte inventories', t => {
  const f = fixture(t);
  const lock = join(f.checkout, 'package-lock.json'); writeFileSync(lock, readFileSync(lock, 'utf8') + '\n');
  f.git('add', '-A'); f.git('commit', '-qm', 'shared lock input change'); const head = f.git('rev-parse', 'HEAD');
  const discovery = discover({ cwd: f.checkout, base: f.base, head });
  assert.deepEqual(discovery.projects.map(p => p.root), ['.', 'apps/nested']);
  for (const task of buildMatrix(discovery, ['ci'])) {
    const output = join(f.temp, task.id);
    const result = capture({ checkout: f.checkout, output, task, discovery, metadata: { ...f.metadata, workflowRevision: head }, inputs: { profiles: ['ci'] } });
    assert.equal(result.status, 'captured', JSON.stringify(result));
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
    verifyBundle(output, manifest);
    assert.equal(manifest.headRevision, head); assert.equal(manifest.recipe.pulseVersion, '1.0.0-beta.10');
    assert.equal(manifest.recipe.profile, 'ci'); assert.equal(manifest.recipe.provider, 'node');
    assert.equal(manifest.baseline.reason, 'not-requested');
    assert.deepEqual(readdirSync(output).sort(), ['capture.json', 'head.html', 'head.json', 'manifest.json']);
    const capsule = JSON.parse(readFileSync(join(output, 'head.json')));
    assert.equal(capsule.provenance.revision, null); assert.equal(capsule.context.target, 'native');
  }
});
test('failed custom build retains only bounded status and stable diagnostics, without raw command output', t => {
  const f = fixture(t), task = buildMatrix(f.discovery, ['ci'])[0], output = join(f.temp, 'failed');
  const result = capture({ ...f, task, output, inputs: { profiles: ['ci'], build_command: 'printf "do-not-upload-raw-data"; exit 9' } });
  assert.equal(result.status, 'failed'); assert.equal(result.phase, 'build'); assert.equal(result.exitCode, 9);
  assert.equal(result.failureCode, 'REPORT_ACTION_BUILD_FAILED');
  assert.deepEqual(readdirSync(output), ['capture.json']);
  assert.equal(readFileSync(join(output, 'capture.json'), 'utf8').includes('do-not-upload-raw-data'), false);
});
test('nonexecuting build plan is rejected instead of becoming successful build evidence', t => {
  const f = fixture(t), task = buildMatrix(f.discovery, ['ci'])[0], output = join(f.temp, 'planned');
  const result = capture({ ...f, task, output, inputs: { profiles: ['ci'],
    build_command: 'node "$PULSE_CLI" build "$PULSE_PROJECT" --profile "$PULSE_PROFILE" --plan --json' } });
  assert.equal(result.status, 'failed'); assert.equal(result.phase, 'build'); assert.equal(existsSync(join(output, 'manifest.json')), false);
});
test('JavaScript project is explicitly skipped before building a Native report', t => {
  const f = fixture(t), config = join(f.checkout, '.pulse/config.ts');
  writeFileSync(config, readFileSync(config, 'utf8').replace("target: 'native'", "target: 'javascript'"));
  f.git('add', '-A'); f.git('commit', '-qm', 'explicit JavaScript target'); const head = f.git('rev-parse', 'HEAD');
  const discovery = discover({ cwd: f.checkout, base: f.base, head });
  const task = buildMatrix(discovery, ['ci']).find(t => t.root === '.');
  const output = join(f.temp, 'javascript');
  const result = capture({ ...f, task, output, discovery, inputs: { profiles: ['ci'] } });
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'unsupported-javascript-target');
  assert.deepEqual(readdirSync(output), ['capture.json']);
});
test('no-op discovery schedules no installs; removed projects retain skip status without resolving dependencies', t => {
  const f = fixture(t);
  assert.deepEqual(buildMatrix(discover({ cwd: f.checkout, base: f.head, head: f.head }), ['ci']), []);
  rmSync(join(f.checkout, 'apps/nested/.pulse/config.ts')); f.git('add', '-A'); f.git('commit', '-qm', 'remove nested configuration');
  const head = f.git('rev-parse', 'HEAD'), discovery = discover({ cwd: f.checkout, base: f.head, head });
  const task = buildMatrix(discovery, ['ci']).find(t => t.status === 'removed');
  const result = capture({ ...f, discovery, task, output: join(f.temp, 'removed'), inputs: { profiles: ['ci'] } });
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'project-removed');
  assert.equal(existsSync(join(f.checkout, 'node_modules')), false);
});
