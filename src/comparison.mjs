import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat, sha256 } from './contracts.mjs';
import { capture, normalizeInputs } from './capture.mjs';
import { verifyBundle, sealBundle, regularBytes } from './evidence.mjs';
import { verifyBaseline } from './baseline-evidence.mjs';

export async function compareProject({ checkout, tooling, stage, output, task, inputs, rebuild = capture }) {
  const plan = JSON.parse(readFileSync(join(tooling, 'plan.json'))), lookup = JSON.parse(regularBytes(stage, 'lookup.json'));
  const options = normalizeInputs(inputs);
  requireThat(options.compareInternal && sha256(JSON.stringify(options)) === plan.inputsSha256, 'Comparison requires the prepared validation opt-in');
  requireThat(plan.tasks.some(t => ['id', 'root', 'status', 'profile', 'reason'].every(k => t[k] === task[k])), 'Comparison task differs');
  mkdirSync(output);
  const result = { ...lookup.head, comparison: true, phase: 'comparison', artifactName: lookup.head.artifactName + '-comparison', baselineSource: { status: lookup.status, reason: lookup.reason ?? null } };
  try {
    if (!existsSync(join(stage, 'head'))) { writeFileSync(join(output, 'capture.json'), JSON.stringify(result, null, 2) + '\n'); return result; }
    const headRoot = join(stage, 'head'), head = verifyBundle(headRoot, JSON.parse(regularBytes(headRoot, 'manifest.json')));
    for (const role of ['head-json', 'head-html']) copyFileSync(join(headRoot, head.files.find(f => f.role === role).path), join(output, role.replace('-', '.')));
    let baseRoot, base;
    if (lookup.status === 'retained') {
      baseRoot = join(stage, 'retained'); base = verifyBaseline(baseRoot, lookup.manifest);
      result.baselineSource = { status: 'retained', ...lookup.binding, recipe: base.recipe };
    } else if (lookup.status === 'rebuild') {
      baseRoot = join(stage, 'rebuilt');
      const baseDiscovery = { ...plan.discovery, headRevision: plan.discovery.baselineRevision,
        targetBaseRevision: plan.discovery.baselineRevision, projects: [{ ...task, status: 'existing' }] };
      const rebuilt = rebuild({ checkout, output: baseRoot, task: { ...task, status: 'existing' }, discovery: baseDiscovery,
        metadata: plan.metadata, inputs: { ...inputs, pulse_version: lookup.recipe.pulseVersion } });
      if (rebuilt.status === 'captured') {
        base = verifyBundle(baseRoot, JSON.parse(regularBytes(baseRoot, 'manifest.json')));
        result.baselineSource = { status: 'rebuilt', reason: lookup.reason, revision: plan.discovery.baselineRevision, recipe: base.recipe, execution: rebuilt.execution };
      } else { result.reason = 'build-failed'; result.baselineSource = { status: 'unavailable', reason: 'build-failed', phase: rebuilt.phase, failureCode: rebuilt.failureCode ?? rebuilt.reason }; }
    }
    const files = [{ role: 'head-json', path: 'head.json' }, { role: 'head-html', path: 'head.html' }];
    let baseline = { status: 'unavailable', revision: plan.discovery.baselineRevision, reason: result.reason ?? lookup.reason ?? 'evidence-missing' };
    if (base) {
      for (const [role, path] of [['head-json', 'base.json'], ['head-html', 'base.html']]) copyFileSync(join(baseRoot, base.files.find(f => f.role === role).path), join(output, path));
      const { compareForValidation } = await import('./compare-validation.mjs');
      const generated = join(stage, 'comparison');
      const receipt = compareForValidation({ before: join(output, 'base.json'), after: join(output, 'head.json'), output: generated, allowInternal: true });
      for (const name of ['compare.json', 'compare.html', 'compare-shim-receipt.json']) copyFileSync(join(generated, name), join(output, name));
      files.push({ role: 'base-json', path: 'base.json' }, { role: 'base-html', path: 'base.html' },
        { role: 'compare-json', path: 'compare.json' }, { role: 'compare-html', path: 'compare.html' }, { role: 'compare-receipt', path: 'compare-shim-receipt.json' });
      baseline = { status: 'available', revision: plan.discovery.baselineRevision, reason: null };
      result.compatibility = receipt.compatibility; result.reason = null;
      result.toolchainChanged = base.recipe.pulseVersion !== head.recipe.pulseVersion || base.recipe.executionSha256 !== head.recipe.executionSha256;
    } else result.reason = baseline.reason;
    const manifest = sealBundle(output, { ...head, baseline, baselineSource: result.baselineSource,
      comparisonAdapter: 'internal-beta10-validation-only', compatibility: result.compatibility ?? null }, files);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    result.files = manifest.files; result.baseline = baseline; result.phase = 'complete';
  } catch {
    result.status = 'failed'; delete result.files; delete result.baseline; result.failureCode = 'REPORT_ACTION_COMPARISON_FAILED';
    for (const name of ['head.json', 'head.html', 'base.json', 'base.html', 'compare.json', 'compare.html', 'compare-shim-receipt.json', 'manifest.json']) rmSync(join(output, name), { force: true });
  }
  writeFileSync(join(output, 'capture.json'), JSON.stringify(result, null, 2) + '\n'); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const e = process.env, result = await compareProject({ checkout: e.REPORT_CHECKOUT, tooling: e.REPORT_TOOLING,
    stage: e.REPORT_STAGE, output: e.REPORT_BUNDLE, task: JSON.parse(e.REPORT_TASK), inputs: JSON.parse(e.REPORT_INPUTS) });
  if (e.GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(e.GITHUB_OUTPUT, `artifact_name=${result.artifactName}\n`);
  if (result.status === 'failed' || result.reason === 'build-failed') process.exitCode = 1;
}
