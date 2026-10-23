import { readFileSync, mkdirSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { requireThat, positiveInteger, revision, projectLabel } from './contracts.mjs';
import { publisherClient, paginate } from './github.mjs';
import { publisherPolicy, validateProducer, currentPull, sourceSnapshot } from './publisher-source.mjs';
import { evidenceReader, reportName, statusName, captureIdentity, admitReport, admitBaseline } from './publisher-artifacts.mjs';
import { presentationName } from './presentation.mjs';

export const marker = '<!-- pulse-report-action:v1 -->';
const statePrefix = '<!-- pulse-report-state:';
// Escape syntax and mentions in every source-derived label. No artifact URLs,
// HTML, titles or arbitrary diagnostics enter the comment body.
export const escapeLabel = value => String(value).replace(/[&<>|`\[\]\\\r\n*_!()#@~]/g, c => `&#${c.charCodeAt(0)};`);
const artifactURL = (repository, run, id) => `https://github.com/${repository}/actions/runs/${run.id}/artifacts/${positiveInteger(id)}`;
const stateFor = (run, pr) => ({ workflowId: run.workflow_id, runId: run.id, runNumber: run.run_number, attempt: run.run_attempt, headRevision: pr.head.sha });
export function renderComment({ repository, pr, run, snapshot, rows }) {
  const state = stateFor(run, pr), e = escapeLabel;
  let text = `${marker}\n${statePrefix}${JSON.stringify(state)} -->\n## Pulse reports\n\nHead: \`${pr.head.sha}\`\n\nBaseline (merge-base): \`${snapshot.discovery.baselineRevision}\`\n\n[Capture run ${run.id}, attempt ${run.run_attempt}](https://github.com/${repository}/actions/runs/${run.id}) — ${run.conclusion}.\n\n`;
  if (!rows.length) text += 'No affected Pulse projects; no reports requested.\n';
  else {
    text += '| Project | Profile | Report | Compare | Evidence | State |\n| --- | --- | --- | --- | --- | --- |\n';
    for (const row of rows) {
      const link = (artifact, label) => artifact ? `[${label}](${artifactURL(repository, run, artifact.id)})` : '—';
      text += `| ${e(projectLabel(row.root, repository))} | ${e(row.profile)} | ${link(row.reportView, 'report.html')} | ${link(row.compareView, 'compare.html')} | ${link(row.evidence ?? row.compare ?? row.report, 'evidence.zip')} | ${e(row.detail)} |\n`;
    }
  }
  text += '\nHTML links download standalone files; evidence.zip contains the full JSON/HTML, checksums and provenance bundle. Downloads require GitHub sign-in and expire with artifact retention. HTML is not publicly hosted. Artifact identity and bytes were checked; project-produced build claims remain untrusted evidence. Comparisons using the beta.10 shim are validation-only.\n';
  requireThat(Buffer.byteLength(text) <= 60000, 'Comment exceeds GitHub body bound'); return text;
}
export function ownedComment(comments, run) {
  const matches = comments.filter(c => c.user?.id === 41898282 && c.user.login === 'github-actions[bot]' && c.user.type === 'Bot' && c.body?.startsWith(marker + '\n'));
  requireThat(matches.length <= 1, 'Multiple bot-owned Pulse comments');
  if (!matches.length) return null;
  const c = matches[0], line = c.body.split('\n')[1];
  requireThat(line?.startsWith(statePrefix) && line.endsWith(' -->') && line.length <= 1024, 'Unrecognized bot comment state');
  const state = JSON.parse(line.slice(statePrefix.length, -4));
  for (const key of ['workflowId', 'runId', 'runNumber', 'attempt']) positiveInteger(state[key]); revision(state.headRevision);
  requireThat(state.workflowId === run.workflow_id, 'Comment belongs to another capture workflow');
  return { ...c, state };
}
async function associatedPull({ api, run, repository }) {
  const associated = await paginate(api, `/commits/${run.head_sha}/pulls`);
  const numbers = new Set([...associated, ...(run.pull_requests ?? [])].map(p => positiveInteger(p.number)));
  // Fork runs may omit both run.pull_requests and the base repository's
  // commit association. Resolve an exact authenticated owner/branch instead;
  // every candidate is still re-fetched and checked by repository ID + SHA.
  if (!numbers.size && typeof run.head_branch === 'string' && run.head_branch.length > 0 && run.head_branch.length <= 256) {
    const owner = run.head_repository.full_name.split('/')[0];
    const candidates = await paginate(api, `/pulls?state=open&head=${encodeURIComponent(owner + ':' + run.head_branch)}`);
    for (const candidate of candidates) if (currentPull(candidate, run, repository)) numbers.add(positiveInteger(candidate.number));
  }
  requireThat(numbers.size <= 20, 'PR association exceeds bound');
  const current = (await Promise.all([...numbers].map(number => api.json(`/pulls/${number}`)))).filter(pr => currentPull(pr, run, repository));
  requireThat(current.length <= 1, 'Ambiguous PR association');
  return current[0] ?? null;
}
async function fresh({ api, run, pr, repository, policy }) {
  const [current, latest, runs] = await Promise.all([
    api.json(`/pulls/${pr.number}`), api.json(`/actions/runs/${run.id}`),
    paginate(api, `/actions/workflows/${run.workflow_id}/runs?event=pull_request&head_sha=${run.head_sha}`, 'workflow_runs'),
  ]);
  if (!currentPull(current, run, repository) || current.base.sha !== pr.base.sha || current.merge_commit_sha !== pr.merge_commit_sha) return false;
  if (latest.id !== run.id || latest.run_attempt !== run.run_attempt || latest.head_sha !== run.head_sha || latest.workflow_id !== run.workflow_id) return false;
  if (latest.status !== 'completed' || !['success', 'failure'].includes(latest.conclusion)) return false;
  validateProducer(latest, policy, repository);
  return !runs.some(r => r.workflow_id === run.workflow_id && r.path === run.path && r.event === 'pull_request'
    && r.head_sha === run.head_sha && r.head_repository?.full_name === run.head_repository.full_name
    && (r.run_number > run.run_number || (r.id === run.id && r.run_attempt > run.run_attempt)));
}
export async function publish({ api, repository, event, context, policy: inputPolicy, stage, dryRun = false, now = () => Date.now() }) {
  const policy = publisherPolicy(inputPolicy);
  requireThat(context.eventName === 'workflow_run' && event.action === 'completed' && event.repository?.full_name === repository, 'Publisher requires its repository workflow_run completion');
  const repo = await api.json('');
  requireThat(repo.full_name === repository && context.ref === `refs/heads/${repo.default_branch}`, 'Publisher must execute on the default branch');
  positiveInteger(event.workflow_run?.id); positiveInteger(event.workflow_run.run_attempt);
  if (event.workflow_run.event !== 'pull_request') return { status: 'ignored', reason: 'not-a-pr-run' };
  const run = await api.json(`/actions/runs/${event.workflow_run.id}`);
  requireThat(run.id === event.workflow_run.id, 'Source run ID differs');
  if (run.run_attempt !== event.workflow_run.run_attempt) return { status: 'ignored', reason: 'superseded-attempt' };
  if (run.status !== 'completed' || !['success', 'failure'].includes(run.conclusion)) return { status: 'ignored', reason: 'nonterminal-or-cancelled' };
  validateProducer(run, policy, repository);
  for (const key of ['id', 'run_attempt', 'workflow_id', 'run_number']) positiveInteger(run[key]);
  const workflow = await api.json(`/actions/workflows/${encodeURIComponent(policy.captureWorkflow.slice('.github/workflows/'.length))}`);
  requireThat(workflow.id === run.workflow_id && workflow.path === policy.captureWorkflow, 'Capture workflow ID/path differs');
  const pr = await associatedPull({ api, run, repository });
  if (!pr) return { status: 'ignored', reason: 'no-current-pr-association' };
  if (!await fresh({ api, run, pr, repository, policy })) return { status: 'ignored', reason: 'stale-head-base-or-run' };
  const snapshot = await sourceSnapshot({ api, pr, run, repository, policy });
  const tasks = snapshot.discovery.projects.flatMap(t => policy.options.profiles.map(profile => ({ ...t, profile })));
  requireThat(tasks.length <= 256, 'Publisher matrix exceeds bound');
  const artifacts = await paginate(api, `/actions/runs/${run.id}/artifacts`, 'artifacts');
  mkdirSync(stage, { recursive: true }); const read = evidenceReader({ api, stage, now }), rows = [];
  function named(names) {
    const found = artifacts.filter(a => names.includes(a.name)); requireThat(found.length <= 1, 'Ambiguous evidence artifacts'); return found[0] ?? null;
  }
  for (const task of tasks) {
    const row = { root: task.root, profile: task.profile, report: null, compare: null, detail: 'missing report evidence' };
    let reportManifest = null, comparisonManifest = null;
    let expectedRecipe;
    if (task.status !== 'removed') {
      try { expectedRecipe = (await snapshot.recipe(task.profile, policy.providers[task.profile])).recipe; }
      catch { row.detail = 'dependency recipe unavailable; no evidence admitted'; rows.push(row); continue; }
    }
    const prefix = expectedRecipe ? reportName(task, expectedRecipe, run) : null;
    const headNames = [statusName(task, run), ...(prefix ? [prefix] : [])];
    const expected = { repository, headRepository: run.head_repository.full_name, pullRequest: pr.number,
      targetBaseRevision: snapshot.discovery.targetBaseRevision, baselineRevision: snapshot.discovery.baselineRevision,
      headRevision: run.head_sha, projectRoot: task.root, workflowPath: run.path, workflowRevision: snapshot.workflowRevision,
      runId: run.id, attempt: run.run_attempt, recipe: expectedRecipe, toolingRevision: snapshot.toolingRevision };
    let headBundle = null;
    const headArtifact = named(headNames);
    if (headArtifact) {
      headBundle = await read(headArtifact, run);
      if (!headBundle) row.detail = 'report artifact expired';
      else {
        captureIdentity(headBundle.capture, task, run, snapshot, [headArtifact.name]);
        const manifest = admitReport({ bundle: headBundle, artifact: headArtifact, run, task, expected, comparison: false, now: now() });
        if (manifest) { reportManifest = manifest; row.report = headArtifact; row.detail = `baseline unavailable: ${manifest.baseline.reason}`; }
        else row.detail = headBundle.capture.status === 'failed' ? `failed: ${headBundle.capture.failureCode}` : `skipped: ${headBundle.capture.reason}`;
      }
    } else if (task.status === 'removed') row.detail = 'project removed; capture status missing';
    if (policy.options.compareInternal) {
      const compareNames = headNames.map(n => n + '-comparison'), artifact = named(compareNames);
      if (!artifact) row.detail += '; comparison evidence missing';
      else {
        const bundle = await read(artifact, run);
        if (!bundle) row.detail += '; comparison artifact expired';
        else {
          captureIdentity(bundle.capture, task, run, snapshot, [artifact.name]);
          requireThat(bundle.capture.comparison === true, 'Comparison capture marker missing');
          const manifest = admitReport({ bundle, artifact, run, task, expected, comparison: true, now: now() });
          if (!manifest) row.detail = bundle.capture.status === 'failed' ? `comparison failed: ${bundle.capture.failureCode}` : `skipped: ${bundle.capture.reason}`;
          else {
            row.evidence = artifact;
            if (!row.report) { row.report = artifact; reportManifest = manifest; }
            if (manifest.baseline.status === 'available') {
              await admitBaseline({ api, read, manifest, bundle, snapshot, task, run, repository,
                branch: policy.options.baselineBranch || repo.default_branch });
              comparisonManifest = manifest; row.compare = artifact; row.detail = `validation comparison: ${manifest.compatibility}`;
            } else row.detail = `baseline unavailable: ${manifest.baseline.reason}`;
          }
        }
      }
    }
    for (const [role, manifest, fileRole] of [['report', reportManifest, 'head-html'], ['compare', comparisonManifest, 'compare-html']]) {
      if (!manifest) continue;
      const artifact = named([presentationName(prefix, role)]);
      row[role + 'View'] = artifact ? await read.view(artifact, run, manifest.files.find(f => f.role === fileRole)) : null;
      if (!row[role + 'View']) row.detail += `; ${role}.html unavailable`;
    }
    rows.push(row);
  }
  const comments = await paginate(api, `/issues/${pr.number}/comments`), existing = ownedComment(comments, run);
  if (existing && (existing.state.runNumber > run.run_number || (existing.state.runId === run.id && existing.state.attempt > run.run_attempt))) return { status: 'ignored', reason: 'newer-comment' };
  const body = renderComment({ repository, pr, run, snapshot, rows });
  // Global repository concurrency is held by the default-branch workflow.
  // Recheck PR head/base/test-merge and newest run/attempt immediately before
  // the one write. GitHub comments have no atomic PR-head precondition API.
  if (!await fresh({ api, run, pr, repository, policy })) return { status: 'ignored', reason: 'changed-before-publication' };
  if (dryRun) return { status: 'dry-run', pullRequest: pr.number, rows, body };
  if (existing?.body === body) return { status: 'unchanged', pullRequest: pr.number, commentId: existing.id };
  const comment = existing
    ? await api.json(`/issues/comments/${positiveInteger(existing.id)}`, { method: 'PATCH', body: { body } })
    : await api.json(`/issues/${pr.number}/comments`, { method: 'POST', body: { body } });
  return { status: existing ? 'updated' : 'created', pullRequest: pr.number, commentId: positiveInteger(comment.id), body };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const e = process.env, temp = mkdtempSync(join(tmpdir(), 'pulse-publisher-'));
  try {
    requireThat(['true', 'false'].includes(e.REPORT_DRY_RUN), 'Explicit publisher dry-run setting required');
    const result = await publish({ api: publisherClient(e.GITHUB_REPOSITORY, e.GH_TOKEN), repository: e.GITHUB_REPOSITORY,
      event: JSON.parse(readFileSync(e.GITHUB_EVENT_PATH)), context: { eventName: e.GITHUB_EVENT_NAME, ref: e.GITHUB_REF },
      policy: JSON.parse(readFileSync(e.REPORT_POLICY)), stage: join(temp, 'evidence'), dryRun: e.REPORT_DRY_RUN === 'true' });
    if (e.GITHUB_STEP_SUMMARY) appendFileSync(e.GITHUB_STEP_SUMMARY, result.body ?? `Pulse publisher: ${result.status} (${result.reason ?? 'current evidence'}).\n`);
    console.log(JSON.stringify({ status: result.status, reason: result.reason, pullRequest: result.pullRequest, commentId: result.commentId }));
  } catch {
    console.error('REPORT_ACTION_PUBLICATION_REJECTED'); process.exitCode = 1;
    if (e.GITHUB_STEP_SUMMARY) appendFileSync(e.GITHUB_STEP_SUMMARY, 'Pulse publisher rejected unavailable, invalid or ineligible evidence. No comment was published.\n');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
