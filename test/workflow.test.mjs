import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../src/capture.mjs';
import { prepare } from '../src/workflow.mjs';

test('prepare packages only exact tooling/plan and never project code, tokens or command bodies', t => {
  const temp = mkdtempSync(join(tmpdir(), 'report-workflow-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = join(temp, 'consumer'), tooling = join(temp, 'tooling'), stage = join(temp, 'stage');
  const git = (cwd, ...args) => execute('git', args, { cwd }).trim();
  for (const root of [checkout, tooling]) {
    mkdirSync(root); git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
  }
  mkdirSync(join(checkout, '.pulse')); writeFileSync(join(checkout, '.pulse/config.ts'), "throw new Error('must not execute')");
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'base'); const base = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'source.ts'), 'PR'); git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'head'); const head = git(checkout, 'rev-parse', 'HEAD');
  mkdirSync(join(tooling, 'src'));
  for (const name of ['contracts.mjs', 'discover.mjs', 'evidence.mjs', 'capture.mjs', 'workflow.mjs', 'baseline-evidence.mjs', 'baseline.mjs', 'comparison.mjs', 'extract-reports.py']) cpSync(fileURLToPath(new URL('../src/' + name, import.meta.url)), join(tooling, 'src', name));
  git(tooling, 'add', '-A'); git(tooling, 'commit', '-qm', 'tooling'); const toolingRevision = git(tooling, 'rev-parse', 'HEAD');
  const input = { checkout, tooling, stage, inputs: { profiles: '["ci"]', setup_command: 'printf command-body-not-retained' },
    event: { number: 1, repository: { full_name: 'owner/consumer' }, pull_request: { base: { sha: base, repo: { full_name: 'owner/consumer' } }, head: { sha: head } } },
    context: { repository: 'owner/consumer', event: 'pull_request', runId: 2, attempt: 1, workflowRef: 'owner/consumer/.github/workflows/pulse.yml@refs/pull/1/merge', workflowRevision: head, toolingRevision, toolingRepository: 'owner/tooling' } };
  const p = prepare(input);
  assert.equal(p.tasks.length, 1); assert.equal(p.metadata.workflowPath, '.github/workflows/pulse.yml');
  assert.ok(!readFileSync(join(stage, 'plan.json'), 'utf8').includes('command-body-not-retained'));
  assert.equal(p.inputsSha256.length, 64);
  const pushed = { ...input, stage: join(temp, 'push'), event: { after: head, ref: 'refs/heads/main', repository: { full_name: 'owner/consumer', default_branch: 'main' } },
    context: { ...input.context, event: 'push', workflowId: 8 } };
  const approved = prepare(pushed);
  assert.equal(approved.tasks.length, 1); assert.equal(approved.tasks[0].reason, 'approved-push'); assert.equal(approved.metadata.workflowId, 8);
  assert.throws(() => prepare({ ...pushed, event: { ...pushed.event, ref: 'refs/heads/unapproved' } }), /approved baseline branch/);

  assert.throws(() => prepare({ ...input, stage: join(temp, 'bad'), context: { ...input.context, toolingRevision: head } }), /Tooling checkout differs/);
});
