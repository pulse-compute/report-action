import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat, sha256, positiveInteger } from './contracts.mjs';
import { regularBytes, verifyBundle, artifactName } from './evidence.mjs';
import { verifyBaseline, validateBaselineBinding, eligibleRun, selectBaseline } from './baseline-evidence.mjs';
import { contained, normalizeInputs, executionIdentity, execute } from './capture.mjs';

export function githubClient(repository, token, request = fetch) {
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && token, 'Authenticated GitHub repository required');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const url = path => { requireThat(path.startsWith('/') && !path.includes('..'), 'Invalid API path'); return `https://api.github.com/repos/${repository}${path}`; };
  async function body(response, limit) {
    requireThat(response.ok, `GitHub request failed (${response.status})`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; requireThat(length <= limit, 'GitHub response exceeds limit'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  return {
    async json(path) { return JSON.parse(await body(await request(url(path), { headers, redirect: 'error', signal: AbortSignal.timeout(60000) }), 8 * 1024 * 1024)); },
    async archive(id) {
      positiveInteger(id);
      let response = await request(url(`/actions/artifacts/${id}/zip`), { headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = new URL(response.headers.get('location'));
        requireThat(location.protocol === 'https:' && !location.username && !location.password, 'Unsafe archive redirect');
        // GitHub supplies the signed storage URL. Never forward the API token.
        response = await request(location.href, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      }
      return body(response, 130 * 1024 * 1024);
    },
  };
}
async function pages(api, path, key) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const r = await api.json(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    requireThat(Array.isArray(r[key]), 'Unexpected GitHub list response'); rows.push(...r[key]);
    if (r[key].length < 100) return rows;
  }
  throw new Error('Baseline lookup exceeds pagination bound');
}
export async function downloadReports({ api, artifact, output, mode }) {
  positiveInteger(artifact.id);
  requireThat(/^sha256:[a-f0-9]{64}$/.test(artifact.digest || ''), 'Missing archive SHA-256');
  const bytes = await api.archive(artifact.id);
  requireThat(`sha256:${sha256(bytes)}` === artifact.digest, 'Archive digest mismatch');
  const archive = output + '.zip'; writeFileSync(archive, bytes, { flag: 'wx' });
  execute('python3', [fileURLToPath(new URL('./extract-reports.py', import.meta.url)), archive, output, mode]);
  return output;
}
export function baselineRecipe({ checkout, inputs, task, headManifest, toolingRevision }) {
  const options = normalizeInputs(inputs), install = contained(checkout, options.installDirectory);
  const pkgBytes = regularBytes(install, 'package.json'), pkg = JSON.parse(pkgBytes);
  const lockBytes = regularBytes(install, options.packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml');
  const declared = pkg.dependencies?.['@pulse-compute/cli'] ?? pkg.devDependencies?.['@pulse-compute/cli'];
  let pulseVersion = declared;
  if (options.packageManager === 'npm') {
    const lock = JSON.parse(lockBytes);
    pulseVersion = lock.packages?.['node_modules/@pulse-compute/cli']?.version ?? declared;
  }
  normalizeInputs({ pulse_version: pulseVersion });
  requireThat(typeof pulseVersion === 'string', 'Baseline has no exact locked CLI version');
  const pm = options.packageManager === 'npm' ? execute('npm', ['--version'], { cwd: install }).trim() : /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager || '')?.[1];
  requireThat(pm, 'Baseline has no exact package manager pin');
  const execution = executionIdentity({ options, packageManagerVersion: pm, packageBytes: pkgBytes, toolingRevision });
  return { profile: task.profile, provider: headManifest.recipe.provider, target: 'native', pulseVersion,
    lockSha256: sha256(lockBytes), executionSha256: sha256(JSON.stringify(execution)) };
}
export async function recoverRetained({ api, expected, output, now = Date.now() }) {
  const runs = await pages(api, `/actions/workflows/${expected.workflowId}/runs?event=push&head_sha=${expected.revision}`, 'workflow_runs');
  const candidates = [];
  for (const run of runs.filter(r => eligibleRun(r, expected))) {
    for (const artifact of await pages(api, `/actions/runs/${run.id}/artifacts`, 'artifacts')) candidates.push({ run, artifact });
  }
  const candidate = selectBaseline(candidates, expected, now);
  if (!candidate) return { status: 'rebuild', reason: 'missing-expired-or-ineligible' };
  const { run, artifact } = candidate;
  await downloadReports({ api, artifact, output, mode: 'baseline' });
  const manifest = verifyBaseline(output, JSON.parse(regularBytes(output, 'manifest.json')));
  const binding = validateBaselineBinding({ manifest, run, artifact, expected, now });
  // Reruns invalidate old attempts even if the list changed during download.
  const latest = await api.json(`/actions/runs/${run.id}`);
  requireThat(eligibleRun(latest, expected) && latest.run_attempt === run.run_attempt, 'Baseline run changed during lookup');
  return { status: 'retained', manifest, binding };
}
export async function lookup({ api, checkout, tooling, stage, bindingDirectory, task, inputs }) {
  const plan = JSON.parse(readFileSync(join(tooling, 'plan.json'))), options = normalizeInputs(inputs);
  requireThat(options.compareInternal && sha256(JSON.stringify(options)) === plan.inputsSha256, 'Comparison opt-in or inputs differ');
  requireThat(plan.tasks.some(t => ['id', 'root', 'status', 'profile', 'reason'].every(k => t[k] === task[k])), 'Comparison task differs');
  requireThat(execute('git', ['rev-parse', 'HEAD'], { cwd: checkout }).trim() === plan.discovery.baselineRevision, 'Baseline checkout differs');
  mkdirSync(stage);
  const bindingBytes = regularBytes(bindingDirectory, 'binding.json');
  requireThat(bindingBytes.length <= 32768, 'Oversized head binding');
  const binding = JSON.parse(bindingBytes);
  requireThat(binding.schemaVersion === 'pulse.report-action.upload-binding.v1' && binding.capture?.project === task.root
    && binding.capture.profile === task.profile && binding.capture.headRevision === plan.discovery.headRevision
    && binding.capture.runId === plan.metadata.runId && binding.capture.attempt === plan.metadata.attempt
    && binding.artifact.runId === plan.metadata.runId && binding.artifact.attempt === plan.metadata.attempt
    && binding.artifact.name === binding.capture.artifactName, 'Head binding identity differs');
  const result = { schemaVersion: 'pulse.report-action.baseline-lookup.v1', status: 'not-needed', reason: binding.capture.reason ?? 'head-failed', head: binding.capture };
  if (binding.capture.status === 'captured') {
    const artifact = await api.json(`/actions/artifacts/${positiveInteger(binding.artifact.id)}`);
    const run = await api.json(`/actions/runs/${plan.metadata.runId}`);
    requireThat(run.event === 'pull_request' && run.repository?.full_name === plan.metadata.repository
      && run.head_sha === plan.discovery.headRevision && run.run_attempt === plan.metadata.attempt && run.path === plan.metadata.workflowPath, 'Head run identity differs');
    requireThat(artifact.name === binding.artifact.name && artifact.digest === binding.artifact.archiveDigest
      && artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === plan.discovery.headRevision
      && artifact.expired === false && Date.parse(artifact.expires_at) > Date.now(), 'Head artifact binding differs');
    await downloadReports({ api, artifact, output: join(stage, 'head'), mode: 'head' });
    const head = verifyBundle(join(stage, 'head'), JSON.parse(regularBytes(join(stage, 'head'), 'manifest.json')));
    requireThat(artifact.name === artifactName(head) && head.repository === plan.metadata.repository && head.pullRequest === plan.metadata.pullRequest
      && head.headRevision === plan.discovery.headRevision && head.baselineRevision === plan.discovery.baselineRevision
      && head.targetBaseRevision === plan.discovery.targetBaseRevision && head.project.root === task.root && head.recipe.profile === task.profile
      && head.workflow.path === run.path && head.workflow.revision === plan.metadata.workflowRevision
      && head.run.id === run.id && head.run.attempt === run.run_attempt, 'Head manifest identity differs');
    result.headArtifact = { id: artifact.id, archiveDigest: artifact.digest };
    if (task.status === 'added') result.reason = 'new-project';
    else {
      try {
        result.recipe = baselineRecipe({ checkout, inputs, task, headManifest: head, toolingRevision: plan.metadata.toolingRevision });
        const expected = { repository: plan.metadata.repository, revision: plan.discovery.baselineRevision,
          projectRoot: task.root, recipe: result.recipe, branch: plan.metadata.baselineBranch,
          workflowId: run.workflow_id, workflowPath: run.path };
        Object.assign(result, await recoverRetained({ api, expected, output: join(stage, 'retained') }));
      } catch (error) {
        // Corruption/ambiguity and identity violations fail closed. Only inability
        // to derive a baseline recipe is represented as a failed baseline build.
        if (!result.recipe) { result.status = 'unavailable'; result.reason = 'build-failed'; }
        else throw error;
      }
    }
  }
  writeFileSync(join(stage, 'lookup.json'), JSON.stringify(result, null, 2) + '\n'); return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const e = process.env;
  await lookup({ api: githubClient(e.GITHUB_REPOSITORY, e.GH_TOKEN), checkout: e.REPORT_CHECKOUT, tooling: e.REPORT_TOOLING,
    stage: e.REPORT_STAGE, bindingDirectory: e.REPORT_HEAD_BINDING, task: JSON.parse(e.REPORT_TASK), inputs: JSON.parse(e.REPORT_INPUTS) });
}
