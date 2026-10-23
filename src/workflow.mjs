import { appendFileSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, configurations } from './discover.mjs';
import { capture, normalizeInputs, execute } from './capture.mjs';
import { requireThat, revision, positiveInteger, sha256, projectId, projectLabel } from './contracts.mjs';

const output = (name, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  requireThat(!text.includes('\n') && !text.includes('\r'), 'Invalid workflow output');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${text}\n`);
};
const escaped = value => String(value).replace(/[&<>|`\[\]\\\r\n]/g, c => `&#${c.charCodeAt(0)};`);
const summary = text => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text); };
export function buildMatrix(discovery, profiles) {
  const tasks = discovery.projects.flatMap(project => profiles.map(profile => ({ ...project, profile })));
  requireThat(tasks.length <= 256, 'Project/profile matrix exceeds 256 jobs'); return tasks;
}
export function prepare({ checkout, tooling, stage, inputs, event, context }) {
  requireThat(['pull_request', 'push'].includes(context.event), 'Reusable capture supports PR or approved push only');
  const pr = event.pull_request, push = context.event === 'push';
  requireThat(event.repository?.full_name === context.repository, 'Repository identity differs');
  const options = normalizeInputs(inputs), baselineBranch = options.baselineBranch || event.repository.default_branch;
  if (push) {
    requireThat(event.ref === `refs/heads/${baselineBranch}` && !event.deleted, 'Push is not on the approved baseline branch');
    positiveInteger(context.workflowId);
  } else requireThat(pr?.base?.repo?.full_name === context.repository, 'PR repository identity differs');
  const base = revision(push ? event.after : pr.base.sha), head = revision(push ? event.after : pr.head.sha);
  if (!push) positiveInteger(event.number);
  positiveInteger(context.runId); positiveInteger(context.attempt);
  revision(context.workflowRevision); revision(context.toolingRevision);
  requireThat(execute('git', ['rev-parse', 'HEAD'], { cwd: tooling }).trim() === context.toolingRevision, 'Tooling checkout differs from executing workflow');
  requireThat(execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: tooling }).trim() === '', 'Tooling source differs from its revision');
  requireThat(execute('git', ['rev-parse', 'HEAD'], { cwd: checkout }).trim() === head, 'Consumer checkout differs from PR head');
  const discovery = discover({ cwd: checkout, base, head });
  if (push) discovery.projects = [...configurations(checkout, head)].sort().map(root => ({ id: projectId(root), root, status: 'existing', reason: 'approved-push' }));
  const tasks = buildMatrix(discovery, options.profiles);
  const caller = context.workflowRef.split('@')[0], prefix = context.repository + '/';
  requireThat(caller.startsWith(prefix), 'Caller workflow identity differs');
  const metadata = { repository: context.repository, pullRequest: event.number, runId: context.runId, attempt: context.attempt,
    event: context.event, baselineBranch, workflowId: context.workflowId, workflowPath: caller.slice(prefix.length), workflowRevision: context.workflowRevision,
    toolingRevision: context.toolingRevision, toolingRepository: context.toolingRepository };
  // Carry only an input fingerprint through artifacts. Command text stays in
  // the workflow input context rather than being copied into retained data.
  const plan = { schemaVersion: 'pulse.report-action.capture-plan.v1', discovery, tasks, metadata, comparisonRequested: options.compareInternal && !push,
    inputsSha256: sha256(JSON.stringify(options)) };
  mkdirSync(join(stage, 'src'), { recursive: true });
  for (const name of ['contracts.mjs', 'discover.mjs', 'evidence.mjs', 'capture.mjs', 'workflow.mjs', 'baseline-evidence.mjs', 'baseline.mjs', 'comparison.mjs', 'extract-reports.py', 'presentation.mjs']) copyFileSync(join(tooling, 'src', name), join(stage, 'src', name));
  if (options.compareInternal) {
    copyFileSync(join(tooling, 'src/compare-validation.mjs'), join(stage, 'src/compare-validation.mjs'));
    mkdirSync(join(stage, 'validation'));
    for (const name of ['package.json', 'package-lock.json', 'internal-compare-pin.json']) copyFileSync(join(tooling, 'validation', name), join(stage, 'validation', name));
  }
  writeFileSync(join(stage, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

export function summarize({ plan, captures }) {
  let text = `## Pulse report evidence\n\nHead: \`${plan.discovery.headRevision}\`\n\nBaseline revision: \`${plan.discovery.baselineRevision}\`.\n\n`;
  if (!plan.tasks.length) return text + 'No affected Pulse projects; no installation or build ran.\n';
  text += '| Project | Profile | Status | Detail | Report | Compare | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n';
  for (const task of plan.tasks) {
    const matches = captures.filter(c => c.project === task.root && c.profile === task.profile
      && c.runId === plan.metadata.runId && c.attempt === plan.metadata.attempt && c.headRevision === plan.discovery.headRevision);
    const compared = matches.filter(c => c.comparison === true);
    const c = compared.length === 1 ? compared[0] : !plan.comparisonRequested && matches.length === 1 ? matches[0] : null;
    const link = (id, label) => id ? `[${label}](https://github.com/${plan.metadata.repository}/actions/runs/${plan.metadata.runId}/artifacts/${positiveInteger(id)})` : '—';
    const head = matches.find(m => m.comparison !== true);
    text += `| ${escaped(projectLabel(task.root, plan.metadata.repository))} | ${escaped(task.profile)} | ${escaped(c?.status ?? 'missing')} | ${escaped(c?.failureCode ?? c?.compatibility ?? c?.reason ?? (c ? 'Native report; baseline unavailable' : 'No matching terminal capture'))} | ${link(head?.upload?.views?.report?.artifactId, 'report.html')} | ${link(c?.upload?.views?.compare?.artifactId, 'compare.html')} | ${link(c?.upload?.artifactId, 'evidence.zip')} |\n`;
  }
  return text + '\nDownload the named artifacts from this run. Artifacts require GitHub sign-in and expire with retention. Comparison artifacts are validation-only when opted in. PR comments require the separately installed publisher. No provider qualification is claimed.\n';
}

async function main() {
  const action = process.argv[2];
  if (action === 'prepare') {
    const e = process.env;
    const workflowId = e.GH_TOKEN ? (await (await import('./baseline.mjs')).githubClient(e.GITHUB_REPOSITORY, e.GH_TOKEN).json(`/actions/runs/${e.GITHUB_RUN_ID}`)).workflow_id : undefined;
    const plan = prepare({ checkout: e.REPORT_CHECKOUT, tooling: e.REPORT_TOOLING, stage: e.REPORT_STAGE,
      inputs: JSON.parse(e.REPORT_INPUTS), event: JSON.parse(readFileSync(e.GITHUB_EVENT_PATH)),
      context: { repository: e.GITHUB_REPOSITORY, event: e.GITHUB_EVENT_NAME, runId: Number(e.GITHUB_RUN_ID), attempt: Number(e.GITHUB_RUN_ATTEMPT),
        workflowRef: e.GITHUB_WORKFLOW_REF, workflowRevision: e.GITHUB_WORKFLOW_SHA,
        workflowId, toolingRevision: e.REPORT_TOOLING_SHA, toolingRepository: e.REPORT_TOOLING_REPOSITORY } });
    output('matrix', { include: plan.tasks }); output('has_tasks', String(plan.tasks.length > 0)); output('baseline_revision', plan.discovery.baselineRevision);
    summary(summarize({ plan: { ...plan, tasks: [] }, captures: [] }).replace('No affected Pulse projects; no installation or build ran.', `Selected ${plan.tasks.length} project/profile captures.`));
  } else if (action === 'capture') {
    const e = process.env, plan = JSON.parse(readFileSync(join(e.REPORT_TOOLING, 'plan.json'))), task = JSON.parse(e.REPORT_TASK);
    const inputs = JSON.parse(e.REPORT_INPUTS);
    requireThat(sha256(JSON.stringify(normalizeInputs(inputs))) === plan.inputsSha256, 'Capture inputs differ from prepared recipe');
    requireThat(plan.schemaVersion === 'pulse.report-action.capture-plan.v1' && plan.tasks.some(t => ['id', 'root', 'status', 'profile', 'reason'].every(key => t[key] === task[key])), 'Capture task differs from prepared matrix');
    const result = capture({ checkout: e.REPORT_CHECKOUT, output: e.REPORT_BUNDLE, task,
      discovery: plan.discovery, metadata: plan.metadata, inputs });
    output('artifact_name', result.artifactName); output('status', result.status);
    summary(`Pulse capture: **${escaped(result.status)}** for ${escaped(result.project)} / ${escaped(result.profile)}; phase ${escaped(result.phase)}.\n`);
    if (result.status === 'failed') process.exitCode = 1;
  } else if (action === 'bind') {
    const e = process.env, c = JSON.parse(readFileSync(join(e.REPORT_BUNDLE, 'capture.json')));
    const artifactId = positiveInteger(Number(e.REPORT_ARTIFACT_ID));
    requireThat(/^[a-f0-9]{64}$/.test(e.REPORT_ARCHIVE_DIGEST || ''), 'Upload did not return an archive digest');
    const binding = { schemaVersion: 'pulse.report-action.upload-binding.v1', capture: c,
      artifact: { id: artifactId, name: c.artifactName, runId: c.runId, attempt: c.attempt, archiveDigest: `sha256:${e.REPORT_ARCHIVE_DIGEST}` } };
    if (e.REPORT_VIEW_ID) {
      requireThat(['report', 'compare'].includes(e.REPORT_VIEW_ROLE) && /^[a-f0-9]{64}$/.test(e.REPORT_VIEW_DIGEST || ''), 'Invalid HTML upload binding');
      binding.views = { [e.REPORT_VIEW_ROLE]: { artifactId: positiveInteger(Number(e.REPORT_VIEW_ID)), digest: `sha256:${e.REPORT_VIEW_DIGEST}` } };
    }
    mkdirSync(e.REPORT_BINDING_DIRECTORY, { recursive: true });
    writeFileSync(join(e.REPORT_BINDING_DIRECTORY, 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
    summary(`Artifact ID: ${artifactId}; archive SHA-256: \`${e.REPORT_ARCHIVE_DIGEST}\`.\n`);
  } else if (action === 'summary') {
    const e = process.env, plan = JSON.parse(readFileSync(join(e.REPORT_TOOLING, 'plan.json'))), captures = [];
    function scan(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        requireThat(!entry.isSymbolicLink(), 'Summary cannot traverse symlinks');
        const full = join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (basename(full) === 'binding.json') {
          requireThat(lstatSync(full).size <= 32768, 'Oversized capture binding'); const b = JSON.parse(readFileSync(full));
          requireThat(b.schemaVersion === 'pulse.report-action.upload-binding.v1' && /^sha256:[a-f0-9]{64}$/.test(b.artifact?.archiveDigest || ''), 'Invalid upload binding');
          positiveInteger(b.artifact.id);
          requireThat(b.artifact.runId === plan.metadata.runId && b.artifact.attempt === plan.metadata.attempt
            && b.artifact.name === b.capture?.artifactName, 'Upload binding differs from run');
          for (const [role, v] of Object.entries(b.views ?? {})) {
            requireThat(['report', 'compare'].includes(role) && /^sha256:[a-f0-9]{64}$/.test(v.digest || ''), 'Invalid HTML binding');
            positiveInteger(v.artifactId);
          }
          captures.push({ ...b.capture, upload: { artifactId: b.artifact.id, views: b.views } });
        }
      }
    }
    scan(e.REPORT_CAPTURES); summary(summarize({ plan, captures }));
  } else throw new Error('Expected prepare, capture or summary');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
