import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { requireThat, revision, safePath, projectRoot, positiveInteger, sha256, projectId } from './contracts.mjs';

const roles = new Map([
  ['head-json', '.json'], ['head-html', '.html'], ['base-json', '.json'],
  ['base-html', '.html'], ['compare-json', '.json'], ['compare-html', '.html'], ['compare-receipt', '.json'],
]);
const digest = value => requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256 digest');
const label = value => requireThat(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value), 'Invalid identity label');
export const recipeKey = recipe => JSON.stringify(['profile', 'provider', 'target', 'pulseVersion', 'lockSha256', 'executionSha256'].map(key => recipe[key] ?? null));

export function validateManifest(m) {
  requireThat(m?.schemaVersion === 'pulse.report-action.evidence.v1', 'Unsupported evidence manifest');
  requireThat(typeof m.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.repository), 'Invalid repository');
  positiveInteger(m.pullRequest);
  revision(m.targetBaseRevision); revision(m.baselineRevision); revision(m.headRevision);
  projectRoot(m.project?.root);
  requireThat(m.project.id === projectId(m.project.root), 'Project identity mismatch');
  for (const key of ['profile', 'provider', 'pulseVersion']) label(m.recipe?.[key]);
  requireThat(m.recipe.target === 'native', 'Only Native report evidence is supported');
  digest(m.recipe.lockSha256);
  if (m.recipe.executionSha256 !== undefined) digest(m.recipe.executionSha256);
  safePath(m.workflow?.path); revision(m.workflow.revision);
  positiveInteger(m.run?.id); positiveInteger(m.run.attempt);
  requireThat(m.run.event === 'pull_request', 'PR evidence must identify its pull_request run');
  requireThat(['available', 'unavailable'].includes(m.baseline?.status), 'Invalid baseline status');
  requireThat(m.baseline.revision === m.baselineRevision, 'Baseline identity mismatch');
  if (m.baseline.status === 'unavailable') {
    requireThat(['new-project', 'build-failed', 'evidence-missing', 'not-requested'].includes(m.baseline.reason), 'Missing baseline reason');
  } else requireThat(m.baseline.reason === null, 'Available baseline cannot carry a missing-evidence reason');
  requireThat(Array.isArray(m.files) && m.files.length >= 2 && m.files.length <= roles.size, 'Invalid report inventory');
  const paths = new Set(), found = new Set();
  for (const f of m.files) {
    safePath(f.path);
    requireThat(roles.has(f.role) && f.path.endsWith(roles.get(f.role)), 'Invalid report role or extension');
    requireThat(!paths.has(f.path) && !found.has(f.role), 'Duplicate report file or role');
    paths.add(f.path); found.add(f.role); digest(f.sha256);
    requireThat(Number.isSafeInteger(f.bytes) && f.bytes > 0 && f.bytes <= 64 * 1024 * 1024, 'Invalid report byte count');
  }
  requireThat(found.has('head-json') && found.has('head-html'), 'Head report JSON and HTML are required');
  if (m.baseline.status === 'available') {
    requireThat(['base-json', 'base-html', 'compare-json', 'compare-html'].every(role => found.has(role)), 'Available baseline requires full report and comparison evidence');
  } else requireThat([...found].every(role => role.startsWith('head-')), 'Unavailable baseline cannot claim comparison evidence');
  if (m.baseline.status === 'available' && m.comparisonAdapter === 'internal-beta10-validation-only') requireThat(found.has('compare-receipt'), 'Internal comparison requires the pinned adapter receipt');
  return m;
}

export function regularBytes(root, name) {
  safePath(name);
  const base = realpathSync(root), file = resolve(base, name);
  // Reject symbolic links in every path component, including contained links.
  let at = base;
  for (const part of name.split('/')) {
    at = resolve(at, part);
    requireThat(!lstatSync(at).isSymbolicLink(), 'Evidence paths cannot traverse symlinks');
  }
  const rel = relative(base, realpathSync(file));
  requireThat(rel !== '..' && !rel.startsWith('..' + sep) && lstatSync(file).isFile(), 'Evidence must be a contained regular file');
  requireThat(lstatSync(file).size <= 64 * 1024 * 1024, 'Report exceeds 64 MiB');
  return readFileSync(file);
}

export function sealBundle(root, identity, files) {
  const inventory = files.map(({ role, path }) => {
    const bytes = regularBytes(root, path);
    return { role, path, bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((a, b) => a.role.localeCompare(b.role));
  return validateManifest({ ...identity, schemaVersion: 'pulse.report-action.evidence.v1',
    project: { root: identity.project.root, id: projectId(identity.project.root) }, files: inventory });
}

export function verifyBundle(root, manifest) {
  validateManifest(manifest);
  for (const entry of manifest.files) {
    const bytes = regularBytes(root, entry.path);
    requireThat(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'Report bytes differ from manifest');
  }
  return manifest;
}

// The caller must obtain expected identity from GitHub's authenticated run/PR
// metadata, never from the downloaded bundle itself. Hashes bind bytes; they
// do not attest that an untrusted build made truthful claims.
export function validateArtifactBinding({ artifact, run, manifest, expected, now = Date.now() }) {
  validateManifest(manifest);
  requireThat(run?.status === 'completed' && run.conclusion === 'success' && run.event === 'pull_request', 'Artifact run is not successful PR evidence');
  requireThat(run.repository?.full_name === expected.repository && run.head_repository?.full_name === expected.headRepository, 'Run repository identity mismatch');
  requireThat(run.head_sha === expected.headRevision && run.path === expected.workflowPath, 'Run revision or workflow mismatch');
  requireThat(run.id === expected.runId && run.run_attempt === expected.attempt, 'Run identity or attempt mismatch');
  requireThat(manifest.repository === expected.repository && manifest.pullRequest === expected.pullRequest
    && manifest.headRevision === expected.headRevision && manifest.baselineRevision === expected.baselineRevision
    && manifest.targetBaseRevision === expected.targetBaseRevision && manifest.project.root === expected.projectRoot
    && manifest.workflow.path === expected.workflowPath && manifest.workflow.revision === expected.workflowRevision
    && manifest.run.id === run.id && manifest.run.attempt === run.run_attempt, 'Manifest identity mismatch');
  requireThat(recipeKey(manifest.recipe) === recipeKey(expected.recipe), 'Build recipe mismatch');
  const name = artifactName(manifest);
  requireThat(artifact?.name === name && artifact.expired === false
    && Number.isFinite(Date.parse(artifact.expires_at)) && Date.parse(artifact.expires_at) > now
    && /^sha256:[a-f0-9]{64}$/.test(artifact.digest || ''), 'Artifact name, retention or digest mismatch');
  positiveInteger(artifact.id);
  requireThat(artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === expected.headRevision, 'Artifact run mismatch');
  return { artifactId: artifact.id, archiveDigest: artifact.digest, name, runId: run.id, attempt: run.run_attempt };
}

export function artifactName(manifest) {
  validateManifest(manifest);
  return `pulse-report-${manifest.project.id}-${sha256(recipeKey(manifest.recipe)).slice(0, 16)}-${manifest.run.id}-${manifest.run.attempt}`;
}
