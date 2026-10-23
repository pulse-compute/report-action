import { validateManifest, regularBytes, recipeKey } from './evidence.mjs';
import { requireThat, revision, positiveInteger, projectId, sha256 } from './contracts.mjs';

function asReport(m) {
  return { ...m, schemaVersion: 'pulse.report-action.evidence.v1', pullRequest: 1,
    targetBaseRevision: m.revision, baselineRevision: m.revision, headRevision: m.revision,
    run: { ...m.run, event: 'pull_request' }, baseline: { status: 'unavailable', revision: m.revision, reason: 'not-requested' } };
}
export function validateBaseline(m) {
  requireThat(m?.schemaVersion === 'pulse.report-action.baseline.v1', 'Expected approved-push baseline manifest');
  revision(m.revision); positiveInteger(m.workflow?.id);
  requireThat(m.run?.event === 'push' && m.workflow.revision === m.revision, 'Baseline must originate from its exact push workflow revision');
  requireThat(typeof m.branch === 'string' && m.branch.length > 0 && m.branch.length <= 256, 'Missing approved branch');
  requireThat(/^[a-f0-9]{64}$/.test(m.recipe?.executionSha256 || ''), 'Missing baseline execution identity');
  validateManifest(asReport(m)); return m;
}
export function sealBaseline(root, identity, files) {
  return validateBaseline({ schemaVersion: 'pulse.report-action.baseline.v1', repository: identity.repository,
    revision: identity.headRevision, project: { root: identity.project.root, id: projectId(identity.project.root) },
    recipe: identity.recipe, workflow: identity.workflow, branch: identity.branch, run: identity.run,
    files: files.map(f => { const b = regularBytes(root, f.path); return { ...f, bytes: b.length, sha256: sha256(b) }; }) });
}
export function verifyBaseline(root, manifest) {
  validateBaseline(manifest);
  for (const f of manifest.files) { const b = regularBytes(root, f.path); requireThat(b.length === f.bytes && sha256(b) === f.sha256, 'Baseline bytes differ from manifest'); }
  return manifest;
}
export function baselineArtifactName(m) {
  validateBaseline(m);
  return `pulse-baseline-${m.project.id}-${sha256(recipeKey(m.recipe)).slice(0, 16)}-${m.run.id}-${m.run.attempt}`;
}
export function eligibleRun(run, expected) {
  return run.status === 'completed' && run.conclusion === 'success' && run.event === 'push'
    && run.repository?.full_name === expected.repository && run.head_repository?.full_name === expected.repository
    && run.head_sha === expected.revision && run.head_branch === expected.branch
    && run.workflow_id === expected.workflowId && run.path === expected.workflowPath;
}
export function validateBaselineBinding({ manifest, run, artifact, expected, now = Date.now() }) {
  validateBaseline(manifest);
  requireThat(eligibleRun(run, expected), 'Ineligible baseline producer');
  positiveInteger(run.id); positiveInteger(run.run_attempt); positiveInteger(artifact?.id);
  requireThat(manifest.repository === expected.repository && manifest.revision === expected.revision
    && manifest.branch === expected.branch && manifest.project.root === expected.projectRoot
    && manifest.workflow.id === expected.workflowId && manifest.workflow.path === expected.workflowPath
    && manifest.run.id === run.id && manifest.run.attempt === run.run_attempt, 'Baseline identity or attempt mismatch');
  requireThat(recipeKey(manifest.recipe) === recipeKey(expected.recipe), 'Baseline recipe mismatch');
  requireThat(artifact.name === baselineArtifactName(manifest) && artifact.expired === false
    && Date.parse(artifact.expires_at) > now && /^sha256:[a-f0-9]{64}$/.test(artifact.digest || '')
    && artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === expected.revision, 'Baseline artifact identity, digest or retention mismatch');
  return { artifactId: artifact.id, archiveDigest: artifact.digest, runId: run.id, attempt: run.run_attempt,
    workflowId: run.workflow_id, workflowPath: run.path, revision: run.head_sha, branch: run.head_branch };
}
// Only the current attempt of each authenticated run is considered. Ambiguous
// eligible archives are never resolved by choosing the newest/nearest result.
export function selectBaseline(candidates, expected, now = Date.now()) {
  const valid = candidates.filter(({ run, artifact }) => eligibleRun(run, expected)
    && artifact.expired === false && Date.parse(artifact.expires_at) > now
    && artifact.name === `pulse-baseline-${projectId(expected.projectRoot)}-${sha256(recipeKey(expected.recipe)).slice(0, 16)}-${run.id}-${run.run_attempt}`);
  requireThat(valid.length <= 1, 'Ambiguous retained baseline');
  return valid[0] ?? null;
}
