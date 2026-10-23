import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, execute, normalizeInputs } from '../src/capture.mjs';
import { discover } from '../src/discover.mjs';
import { compareProject } from '../src/comparison.mjs';
import { baselineRecipe } from '../src/baseline.mjs';
import { verifyBundle } from '../src/evidence.mjs';
import { sealBaseline, verifyBaseline } from '../src/baseline-evidence.mjs';
import { admitReport } from '../src/publisher-artifacts.mjs';
import { sha256 } from '../src/contracts.mjs';

test('real installed pair rebuilds the exact baseline, then reuses push evidence without rebuilding; missing baselines stay explicit', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'pulse-ra02-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = join(temp, 'comparison-fixture'), tooling = join(temp, 'tooling'); mkdirSync(tooling);
  cpSync(fileURLToPath(new URL('../fixtures/consumer/', import.meta.url)), checkout, { recursive: true, filter: n => !['node_modules', 'dist', 'reports'].includes(basename(n)) });
  const git = (...args) => execute('git', args, { cwd: checkout }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '-A'); git('commit', '-qm', 'baseline'); const base = git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, 'src/index.ts'), readFileSync(join(checkout, 'src/index.ts'), 'utf8') + '\n// candidate\n');
  git('add', '-A'); git('commit', '-qm', 'head'); const head = git('rev-parse', 'HEAD');
  const discovery = discover({ cwd: checkout, base, head }), task = { ...discovery.projects[0], profile: 'ci' };
  const metadata = { repository: 'fixture/comparison-fixture', pullRequest: 1, runId: 123, attempt: 1, event: 'pull_request', workflowPath: '.github/workflows/pulse.yml', workflowRevision: head, toolingRevision: 'a'.repeat(40) };
  const inputs = { profiles: ['ci'], compare_internal_beta10: true };
  const plan = { discovery, tasks: [task], metadata, inputsSha256: sha256(JSON.stringify(normalizeInputs(inputs))) };
  writeFileSync(join(tooling, 'plan.json'), JSON.stringify(plan));
  const stage = join(temp, 'stage'); mkdirSync(stage);
  const captured = capture({ checkout, output: join(stage, 'head'), task, discovery, metadata, inputs });
  assert.equal(captured.status, 'captured', JSON.stringify(captured));
  const originalHead = readFileSync(join(stage, 'head/head.json'));
  git('checkout', '--detach', base);
  const headManifest = JSON.parse(readFileSync(join(stage, 'head/manifest.json')));
  const recipe = baselineRecipe({ checkout, inputs, task, headManifest, toolingRevision: metadata.toolingRevision });
  const lookup = { status: 'rebuild', reason: 'missing-expired-or-ineligible', head: captured, recipe };
  writeFileSync(join(stage, 'lookup.json'), JSON.stringify(lookup));
  const output = join(temp, 'compared'), result = await compareProject({ checkout, tooling, stage, output, task, inputs });
  assert.equal(result.status, 'captured', JSON.stringify(result)); assert.equal(result.baselineSource.status, 'rebuilt'); assert.equal(result.baselineSource.revision, base);
  const manifest = verifyBundle(output, JSON.parse(readFileSync(join(output, 'manifest.json'))));
  const producer = { id: metadata.runId, run_attempt: metadata.attempt, event: 'pull_request', status: 'completed', conclusion: 'success',
    repository: { full_name: metadata.repository }, head_repository: { full_name: metadata.repository }, head_sha: head, path: metadata.workflowPath };
  const evidence = { root: output, capture: result, entries: readdirSync(output).sort() };
  const admitted = admitReport({ bundle: evidence, artifact: { id: 20, name: result.artifactName, digest: 'sha256:' + 'a'.repeat(64), expired: false,
    expires_at: '2099-01-01', workflow_run: { id: producer.id, head_sha: head } }, run: producer, task,
    expected: { repository: metadata.repository, headRepository: metadata.repository, pullRequest: 1, targetBaseRevision: base, baselineRevision: base,
      headRevision: head, projectRoot: task.root, workflowPath: metadata.workflowPath, workflowRevision: head, runId: producer.id, attempt: producer.run_attempt,
      recipe: headManifest.recipe, toolingRevision: metadata.toolingRevision }, comparison: true, now: Date.now() });
  assert.deepEqual(admitted, manifest);
  assert.equal(manifest.baseline.status, 'available'); assert.equal(manifest.headRevision, head); assert.equal(manifest.baselineRevision, base); assert.equal(manifest.files.length, 7);
  assert.deepEqual(readFileSync(join(output, 'head.json')), originalHead);
  assert.equal(JSON.parse(readFileSync(join(output, 'base.json'))).provenance.revision, null);
  for (const side of ['head', 'base']) assert.equal(JSON.parse(readFileSync(join(output, `${side}.json`))).application.name, 'comparison-fixture');
  assert.ok(readFileSync(join(output, 'compare.html'), 'utf8').includes(JSON.stringify('comparison-fixture')));
  assert.equal(JSON.parse(readFileSync(join(output, 'compare-shim-receipt.json'))).purpose, 'validation-only');
  assert.equal(git('rev-parse', 'HEAD'), base);
  // Actual approved-push capture, using the same locked baseline recipe.
  const pushRoot = join(temp, 'push'), pushMetadata = { ...metadata, event: 'push', workflowRevision: base, workflowId: 8, baselineBranch: 'main' };
  const pushDiscovery = { ...discovery, headRevision: base, targetBaseRevision: base, projects: [{ ...task, status: 'existing' }] };
  const push = capture({ checkout, output: pushRoot, task: { ...task, status: 'existing' }, discovery: pushDiscovery, metadata: pushMetadata, inputs });
  assert.equal(push.status, 'captured', JSON.stringify(push));
  const pushManifest = verifyBaseline(pushRoot, JSON.parse(readFileSync(join(pushRoot, 'manifest.json'))));
  assert.equal(pushManifest.run.event, 'push'); assert.equal(pushManifest.workflow.id, 8); assert.equal(pushManifest.recipe.executionSha256, recipe.executionSha256);
  const retainedStage = join(temp, 'retained-stage'); mkdirSync(retainedStage); cpSync(join(stage, 'head'), join(retainedStage, 'head'), { recursive: true }); cpSync(pushRoot, join(retainedStage, 'retained'), { recursive: true });
  writeFileSync(join(retainedStage, 'lookup.json'), JSON.stringify({ ...lookup, status: 'retained', manifest: pushManifest, binding: { artifactId: 20, runId: 10, attempt: 1, revision: base, archiveDigest: 'sha256:' + 'a'.repeat(64) } }));
  const reused = await compareProject({ checkout, tooling, stage: retainedStage, output: join(temp, 'reused'), task, inputs, rebuild: () => { throw Error('must not rebuild'); } });
  assert.equal(reused.status, 'captured'); assert.equal(reused.baselineSource.status, 'retained'); assert.equal(reused.baselineSource.artifactId, 20);
  // Synthetic provider mismatch tests the compatibility boundary using the
  // pinned capsule constructor; it is not claimed as a fresh Fastly build.
  const { loadInternalComparison } = await import('../src/compare-validation.mjs');
  const api = loadInternalComparison({ allowInternal: true });
  const foreign = structuredClone(api.parseCapsule(readFileSync(join(pushRoot, 'head.json'))));
  foreign.context.host = 'fastly'; for (const artifact of foreign.artifacts) artifact.host = 'fastly';
  writeFileSync(join(retainedStage, 'retained/head.json'), api.serializeCapsule(api.createCapsule(foreign)));
  const foreignManifest = sealBaseline(join(retainedStage, 'retained'), { ...pushManifest, headRevision: base, recipe: { ...pushManifest.recipe, provider: 'fastly' } },
    [{ role: 'head-json', path: 'head.json' }, { role: 'head-html', path: 'head.html' }]);
  writeFileSync(join(retainedStage, 'lookup.json'), JSON.stringify({ ...lookup, status: 'retained', manifest: foreignManifest, binding: { artifactId: 21 } }));
  rmSync(join(retainedStage, 'comparison'), { recursive: true });
  const incompatibleOut = join(temp, 'incompatible');
  const incompatible = await compareProject({ checkout, tooling, stage: retainedStage, output: incompatibleOut, task, inputs });
  assert.equal(incompatible.compatibility, 'incompatible');
  const comparison = JSON.parse(readFileSync(join(incompatibleOut, 'compare.json')));
  assert.equal(comparison.summary.artifactBytes.delta, null); assert.equal(comparison.summary.artifactBytes.reason, 'incompatible-artifacts');
  for (const [label, state, reason, override] of [['new', 'not-needed', 'new-project', {}], ['failed', 'rebuild', 'missing-expired-or-ineligible', { rebuild: () => ({ status: 'failed', phase: 'build', failureCode: 'REPORT_ACTION_BUILD_FAILED' }) }]]) {
    const s = join(temp, label); mkdirSync(s); cpSync(join(stage, 'head'), join(s, 'head'), { recursive: true });
    writeFileSync(join(s, 'lookup.json'), JSON.stringify({ ...lookup, status: state, reason }));
    const out = join(temp, label + '-out'); const c = await compareProject({ checkout, tooling, stage: s, output: out, task, inputs, ...override });
    const m = verifyBundle(out, JSON.parse(readFileSync(join(out, 'manifest.json'))));
    assert.equal(m.baseline.status, 'unavailable'); assert.equal(m.baseline.reason, label === 'new' ? 'new-project' : 'build-failed');
    assert.equal(m.files.length, 2); assert.equal(readdirSync(out).includes('compare.json'), false); assert.equal(c.compatibility, undefined);
  }
});
