import { requireThat, revision, safePath, sha256, positiveInteger } from './contracts.mjs';
import { configurationRoots, selectProjects } from './discover.mjs';
import { normalizeInputs, executionIdentity } from './capture.mjs';

const repositoryName = value => requireThat(typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), 'Invalid policy repository');
export function publisherPolicy(input) {
  requireThat(input?.schemaVersion === 'pulse.report-action.publisher-policy.v1', 'Unsupported publisher policy');
  safePath(input.captureWorkflow); safePath(input.tooling?.workflow); repositoryName(input.tooling.repository);
  requireThat([input.captureWorkflow, input.tooling.workflow].every(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)), 'Expected direct workflow file paths');
  if (input.tooling.revision !== 'pr-merge') revision(input.tooling.revision);
  requireThat(/^v\d+\.\d+\.\d+$/.test(input.nodeVersion || ''), 'Pin the capture Node version');
  const options = normalizeInputs(input.inputs);
  if (options.packageManager === 'npm') requireThat(/^\d+\.\d+\.\d+$/.test(input.npmVersion || ''), 'Pin the capture npm version');
  for (const profile of options.profiles) requireThat(typeof input.providers?.[profile] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.providers[profile]), 'Declare each expected Native provider');
  return { ...input, options };
}
export function validateProducer(run, policy, repository) {
  requireThat(run?.repository?.full_name === repository && run.event === 'pull_request'
    && run.path === policy.captureWorkflow && run.status === 'completed'
    && ['success', 'failure'].includes(run.conclusion), 'Ineligible capture run');
  revision(run.head_sha);
  requireThat(run.head_repository?.full_name, 'Missing source repository'); positiveInteger(run.head_repository.id);
}
export function currentPull(pr, run, repository) {
  return pr?.state === 'open' && pr.base?.repo?.full_name === repository && pr.head?.sha === run.head_sha
    && pr.head.ref === run.head_branch && pr.head.repo?.full_name === run.head_repository?.full_name && pr.head.repo?.id === run.head_repository?.id;
}
export async function sourceSnapshot({ api, pr, run, repository, policy }) {
  const head = revision(run.head_sha), base = revision(pr.base.sha), merge = revision(pr.merge_commit_sha);
  const commit = await api.json(`/git/commits/${merge}`);
  requireThat(commit.sha === merge && commit.parents?.length === 2 && commit.parents[0].sha === base && commit.parents[1].sha === head,
    'PR test merge no longer matches base/head');
  const toolingRevision = policy.tooling.revision === 'pr-merge' ? merge : policy.tooling.revision;
  if (policy.tooling.revision === 'pr-merge') requireThat(policy.tooling.repository === repository, 'PR merge tooling must be same-repository validation');
  const referenced = run.referenced_workflows?.filter(w => w.path?.split('@')[0] === `${policy.tooling.repository}/${policy.tooling.workflow}` && w.sha === toolingRevision);
  requireThat(referenced?.length === 1, 'Producer tooling differs from publisher policy');
  const compared = await api.json(`/compare/${base}...${head}?per_page=1`), baseline = revision(compared.merge_base_commit?.sha);
  async function tree(sha) {
    const data = await api.json(`/git/trees/${sha}?recursive=1`);
    requireThat(!data.truncated && Array.isArray(data.tree) && data.tree.length <= 100000, 'Source tree exceeds discovery bound');
    const rows = data.tree.filter(e => e.type !== 'tree'); const seen = new Set();
    for (const e of rows) { safePath(e.path); revision(e.sha); requireThat(!seen.has(e.path), 'Duplicate source path'); seen.add(e.path); }
    return rows;
  }
  const before = await tree(baseline), after = await tree(head);
  const old = new Map(before.map(e => [e.path, `${e.mode}:${e.sha}`])), next = new Map(after.map(e => [e.path, `${e.mode}:${e.sha}`]));
  const changed = [...new Set([...old.keys(), ...next.keys()])].filter(p => old.get(p) !== next.get(p));
  const discovery = { schemaVersion: 'pulse.report-action.discovery.v1', targetBaseRevision: base, baselineRevision: baseline, headRevision: head,
    ...selectProjects({ before: configurationRoots(before), after: configurationRoots(after), changed }) };
  const cache = new Map();
  async function blob(rows, path) {
    const entry = rows.find(e => e.path === path);
    requireThat(entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode) && entry.size > 0 && entry.size <= 4 * 1024 * 1024, 'Expected bounded tracked dependency file');
    if (!cache.has(entry.sha)) {
      const data = await api.json(`/git/blobs/${entry.sha}`);
      requireThat(data.sha === entry.sha && data.encoding === 'base64' && data.size === entry.size, 'Source blob identity differs');
      const bytes = Buffer.from(data.content, 'base64'); requireThat(bytes.length === entry.size, 'Source blob size differs'); cache.set(entry.sha, bytes);
    }
    return cache.get(entry.sha);
  }
  async function recipe(profile, provider, baselineRecipe = false) {
    const rows = baselineRecipe ? before : after, opts = policy.options;
    const prefix = opts.installDirectory === '.' ? '' : opts.installDirectory + '/';
    const packageBytes = await blob(rows, prefix + 'package.json'), pkg = JSON.parse(packageBytes);
    const lockBytes = await blob(rows, prefix + (opts.packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'));
    let pulseVersion = opts.pulseVersion;
    if (baselineRecipe) pulseVersion = opts.packageManager === 'npm'
      ? JSON.parse(lockBytes).packages?.['node_modules/@pulse-compute/cli']?.version ?? pkg.dependencies?.['@pulse-compute/cli'] ?? pkg.devDependencies?.['@pulse-compute/cli']
      : pkg.dependencies?.['@pulse-compute/cli'] ?? pkg.devDependencies?.['@pulse-compute/cli'];
    requireThat(pulseVersion, 'Missing locked baseline CLI'); normalizeInputs({ pulse_version: pulseVersion });
    const pm = opts.packageManager === 'npm' ? policy.npmVersion : /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager || '')?.[1];
    requireThat(pm, 'Missing package manager identity');
    const execution = { ...executionIdentity({ options: opts, packageManagerVersion: pm, packageBytes, toolingRevision }), node: policy.nodeVersion };
    return { recipe: { profile, provider, target: 'native', pulseVersion, lockSha256: sha256(lockBytes), executionSha256: sha256(JSON.stringify(execution)) }, execution };
  }
  return { discovery, toolingRevision, workflowRevision: merge, recipe };
}
