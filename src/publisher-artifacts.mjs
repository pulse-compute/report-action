import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat, sha256, positiveInteger } from './contracts.mjs';
import { execute } from './capture.mjs';
import { regularBytes, verifyBundle, recipeKey, validateArtifactBinding } from './evidence.mjs';
import { verifyBaseline, validateBaselineBinding } from './baseline-evidence.mjs';

const maxArchive = 128 * 1024 * 1024, maxTotal = 512 * 1024 * 1024;
export const statusName = (task, run) => `pulse-report-status-${task.id}-${sha256(task.profile).slice(0, 12)}-${run.id}-${run.run_attempt}`;
export const reportName = (task, recipe, run) => `pulse-report-${task.id}-${sha256(recipeKey(recipe)).slice(0, 16)}-${run.id}-${run.run_attempt}`;
export function artifactMetadata(artifact, run, now) {
  positiveInteger(artifact?.id);
  requireThat(artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === run.head_sha
    && /^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') && Number.isSafeInteger(artifact.size_in_bytes)
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= maxArchive, 'Artifact metadata differs');
  requireThat(Number.isFinite(Date.parse(artifact.expires_at)), 'Missing artifact retention');
  return artifact.expired === false && Date.parse(artifact.expires_at) > now;
}
export function evidenceReader({ api, stage, now = () => Date.now(), budget = maxTotal }) {
  requireThat(Number.isSafeInteger(budget) && budget > 0 && budget <= maxTotal, 'Invalid download budget');
  const cache = new Map(), downloads = new Map(); let total = 0;
  async function download(artifact, run) {
    if (!artifactMetadata(artifact, run, now())) return null;
    if (!downloads.has(artifact.id)) {
      requireThat(total + artifact.size_in_bytes <= budget, 'Evidence download budget exceeded');
      const bytes = await api.archive(artifact.id); total += bytes.length;
      requireThat(bytes.length === artifact.size_in_bytes && total <= budget && `sha256:${sha256(bytes)}` === artifact.digest, 'Archive digest, size or budget mismatch');
      downloads.set(artifact.id, bytes);
    }
    return downloads.get(artifact.id);
  }
  async function read(artifact, run) {
    const bytes = await download(artifact, run);
    if (!bytes) return null;
    if (!cache.has(artifact.id)) {
      const path = join(stage, `artifact-${artifact.id}`), archive = path + '.zip';
      // Never extract or parse before verifying the authenticated archive digest.
      writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
      execute('python3', ['-I', fileURLToPath(new URL('./extract-publisher.py', import.meta.url)), archive, path]);
      const capture = JSON.parse(metadata(path, 'capture.json'));
      cache.set(artifact.id, { root: path, capture, entries: readdirSync(path).sort() });
    }
    return cache.get(artifact.id);
  }
  read.view = async (artifact, run, file) => {
    // Direct artifacts are bytes, never ZIPs to extract or HTML to evaluate.
    requireThat(file && file.bytes <= 64 * 1024 * 1024 && artifact.size_in_bytes === file.bytes
      && artifact.digest === `sha256:${file.sha256}`, 'HTML presentation differs from verified evidence');
    const bytes = await download(artifact, run);
    if (!bytes) return null;
    requireThat(bytes.length === file.bytes && sha256(bytes) === file.sha256, 'HTML presentation bytes differ');
    return artifact;
  };
  return read;
}
function metadata(root, name) { const b = regularBytes(root, name); requireThat(b.length <= 65536, 'Oversized evidence metadata'); return b; }
export function captureIdentity(c, task, run, snapshot, names) {
  requireThat(c?.schemaVersion === 'pulse.report-action.capture.v1' && c.project === task.root && c.profile === task.profile
    && c.runId === run.id && c.attempt === run.run_attempt && c.headRevision === snapshot.discovery.headRevision
    && c.baselineRevision === snapshot.discovery.baselineRevision && names.includes(c.artifactName), 'Capture identity differs');
  requireThat(['captured', 'failed', 'skipped'].includes(c.status), 'Invalid capture status');
  if (task.status === 'removed') requireThat(c.status === 'skipped' && c.reason === 'project-removed', 'Removed project cannot claim build evidence');
  else requireThat(c.reason !== 'project-removed', 'Unexpected project removal');
  if (c.status === 'skipped') requireThat(['project-removed', 'unsupported-javascript-target'].includes(c.reason), 'Invalid capture skip reason');
  if (c.status === 'failed') requireThat(/^REPORT_ACTION_[A-Z0-9_]+$|^PULSE_[A-Z0-9_]+$/.test(c.failureCode || ''), 'Invalid capture failure code');
}
export function admitReport({ bundle, artifact, run, task, expected, comparison, now }) {
  const c = bundle.capture;
  if (c.status !== 'captured') { requireThat(bundle.entries.length === 1, 'Failed capture cannot supply report files'); return null; }
  const m = verifyBundle(bundle.root, JSON.parse(metadata(bundle.root, 'manifest.json')));
  requireThat(Boolean(m.comparisonAdapter) === comparison, 'Unexpected comparison adapter');
  if (task.status === 'added') requireThat(m.baseline.status === 'unavailable' && m.baseline.reason === 'new-project', 'New project cannot claim a baseline');
  else requireThat(m.baseline.reason !== 'new-project', 'Existing project cannot claim new-project state');
  requireThat(JSON.stringify(bundle.entries) === JSON.stringify(['capture.json', 'manifest.json', ...m.files.map(f => f.path)].sort()), 'Bundle inventory differs from manifest');
  const paths = { 'head-json': 'head.json', 'head-html': 'head.html', 'base-json': 'base.json', 'base-html': 'base.html', 'compare-json': 'compare.json', 'compare-html': 'compare.html', 'compare-receipt': 'compare-shim-receipt.json' };
  requireThat(m.files.every(f => paths[f.role] === f.path), 'Unexpected evidence filenames');
  validateArtifactBinding({ artifact, run, manifest: m, expected, now, allowFailedRun: true });
  requireThat(recipeKey(c.recipe) === recipeKey(expected.recipe) && c.execution && sha256(JSON.stringify(c.execution)) === expected.recipe.executionSha256
    && c.toolingRevision === expected.toolingRevision && JSON.stringify(c.files) === JSON.stringify(m.files)
    && JSON.stringify(c.baseline) === JSON.stringify(m.baseline), 'Capture recipe or inventory differs');
  const capsule = JSON.parse(regularBytes(bundle.root, 'head.json'));
  requireThat(capsule.kind === 'pulse.application-report' && capsule.context?.profile === task.profile && capsule.context.host === expected.recipe.provider
    && capsule.context.target === 'native' && capsule.producer?.pulseVersion === expected.recipe.pulseVersion, 'Report selection differs');
  if (m.baseline.status === 'available') {
    requireThat(comparison && ['compatible', 'different-build', 'unknown', 'incompatible'].includes(m.compatibility) && c.compatibility === m.compatibility, 'Invalid comparison compatibility');
    const receipt = JSON.parse(metadata(bundle.root, 'compare-shim-receipt.json'));
    const pin = readFileSync(fileURLToPath(new URL('../validation/internal-compare-pin.json', import.meta.url)));
    requireThat(receipt.purpose === 'validation-only' && receipt.adapter === 'internal-beta10-validation' && receipt.packageVersion === '1.0.0-beta.10'
      && receipt.pinSha256 === sha256(pin) && receipt.compatibility === m.compatibility
      && receipt.inputs?.beforeSha256 === sha256(regularBytes(bundle.root, 'base.json'))
      && receipt.inputs.afterSha256 === sha256(regularBytes(bundle.root, 'head.json')), 'Comparison receipt differs');
    const compared = JSON.parse(regularBytes(bundle.root, 'compare.json'));
    requireThat(compared.kind === 'pulse.report-comparison' && compared.comparisonVersion === 1 && compared.compatibility?.status === m.compatibility && JSON.stringify(compared.comparisonHash) === JSON.stringify(receipt.comparisonHash), 'Comparison identity differs');
    requireThat(Array.isArray(receipt.files) && receipt.files.length === 2 && receipt.files.every(f => ['compare.json', 'compare.html'].includes(f.path)
      && m.files.some(e => e.path === f.path && e.sha256 === f.sha256 && e.bytes === f.bytes)), 'Comparison receipt inventory differs');
  }
  return m;
}
export async function admitBaseline({ api, read, manifest, bundle, snapshot, task, run, repository, branch }) {
  if (manifest.baseline.status !== 'available') return;
  const source = manifest.baselineSource;
  requireThat(source && ['retained', 'rebuilt'].includes(source.status), 'Missing baseline provenance');
  requireThat(typeof source.recipe?.provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(source.recipe.provider), 'Invalid baseline provider');
  const expected = await snapshot.recipe(task.profile, source.recipe.provider, true);
  requireThat(recipeKey(source.recipe) === recipeKey(expected.recipe), 'Baseline recipe differs from source');
  const capsule = JSON.parse(regularBytes(bundle.root, 'base.json'));
  requireThat(capsule.kind === 'pulse.application-report' && capsule.context?.profile === task.profile && capsule.context.target === 'native'
    && capsule.context.host === source.recipe.provider && capsule.producer?.pulseVersion === expected.recipe.pulseVersion, 'Baseline report selection differs');
  if (source.status === 'rebuilt') {
    requireThat(source.revision === snapshot.discovery.baselineRevision && sha256(JSON.stringify(source.execution)) === expected.recipe.executionSha256, 'Rebuilt baseline identity differs');
  } else {
    const producer = await api.json(`/actions/runs/${positiveInteger(source.runId)}`);
    const artifact = await api.json(`/actions/artifacts/${positiveInteger(source.artifactId)}`);
    requireThat(source.attempt === producer.run_attempt && source.archiveDigest === artifact.digest
      && source.workflowId === run.workflow_id && source.workflowPath === run.path && source.revision === snapshot.discovery.baselineRevision && source.branch === branch,
      'Retained baseline binding differs');
    const cached = await read(artifact, producer); requireThat(cached, 'Retained baseline expired');
    const m = verifyBaseline(cached.root, JSON.parse(metadata(cached.root, 'manifest.json')));
    validateBaselineBinding({ manifest: m, run: producer, artifact, expected: { repository, revision: snapshot.discovery.baselineRevision, branch,
      workflowId: run.workflow_id, workflowPath: run.path, projectRoot: task.root, recipe: expected.recipe } });
    requireThat(sha256(regularBytes(cached.root, 'head.json')) === sha256(regularBytes(bundle.root, 'base.json'))
      && sha256(regularBytes(cached.root, 'head.html')) === sha256(regularBytes(bundle.root, 'base.html')), 'Retained baseline bytes differ');
    const latest = await api.json(`/actions/runs/${producer.id}`);
    requireThat(latest.run_attempt === producer.run_attempt, 'Retained producer attempt changed during admission');
    validateBaselineBinding({ manifest: m, run: latest, artifact, expected: { repository, revision: snapshot.discovery.baselineRevision, branch,
      workflowId: run.workflow_id, workflowPath: run.path, projectRoot: task.root, recipe: expected.recipe } });
  }
}
