import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInputs, execute } from '../src/capture.mjs';
import { buildMatrix, summarize } from '../src/workflow.mjs';

test('capture options reject floating versions, shell profile injection and invalid managers', () => {
  assert.deepEqual(normalizeInputs({ profiles: '["ci"]' }).profiles, ['ci']);
  for (const change of [{ profiles: '["ci;bad"]' }, { pulse_version: 'latest' }, { package_manager: 'yarn' },
    { profiles: '[]' }, { profiles: ['ci', 'ci'] }, { install_directory: '../outside' }]) assert.throws(() => normalizeInputs(change));
  assert.throws(() => buildMatrix({ projects: Array.from({ length: 129 }, () => ({ root: '.' })) }, ['a', 'b']), /256/);
});
test('project subprocesses receive neither repository tokens nor GitHub file-command paths', () => {
  const before = { ...process.env };
  try {
    process.env.GITHUB_TOKEN = 'token'; process.env.ACTIONS_RUNTIME_TOKEN = 'runtime'; process.env.GITHUB_OUTPUT = '/tmp/nope'; process.env.GITHUB_STATE = '/tmp/never-write-state';
    const value = execute(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.GITHUB_TOKEN,process.env.ACTIONS_RUNTIME_TOKEN,process.env.GITHUB_OUTPUT,process.env.GITHUB_STATE]))']);
    assert.equal(value, '[null,null,null,null]');
  } finally { for (const name of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_OUTPUT', 'GITHUB_STATE']) {
    if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
  } }
});
test('summary distinguishes missing/failed/skipped evidence and escapes project Markdown', () => {
  const plan = { discovery: { headRevision: '1'.repeat(40), baselineRevision: '2'.repeat(40) },
    metadata: { repository: 'owner/repo', runId: 1, attempt: 1 },
    tasks: [{ root: 'app|[link]', profile: 'ci' }, { root: 'removed', profile: 'ci' }, { root: 'failed', profile: 'ci' }] };
  const captures = ['removed', 'failed'].map((project, i) => ({ project, profile: 'ci', runId: 1, attempt: 1,
    headRevision: plan.discovery.headRevision, status: i ? 'failed' : 'skipped', reason: i ? null : 'project-removed',
    failureCode: i ? 'REPORT_ACTION_BUILD_FAILED' : null, upload: { artifactId: 3 } }));
  const text = summarize({ plan, captures });
  assert.match(text, /missing/); assert.match(text, /REPORT_ACTION_BUILD_FAILED/); assert.match(text, /project-removed/);
  assert.ok(!text.includes('app|[link]')); assert.match(text, /artifacts\/3/);
});
