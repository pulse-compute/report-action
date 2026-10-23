import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { requireThat, revision, projectRoot, positiveInteger, sha256 } from './contracts.mjs';
import { sealBundle, artifactName } from './evidence.mjs';
import { sealBaseline, baselineArtifactName } from './baseline-evidence.mjs';

const maxBytes = 64 * 1024 * 1024;
export function contained(root, path) {
  const base = realpathSync(root), full = resolve(base, projectRoot(path));
  let at = base;
  for (const part of relative(base, full).split(sep).filter(Boolean)) {
    at = join(at, part); requireThat(!lstatSync(at).isSymbolicLink(), 'Project paths cannot traverse symbolic links');
  }
  requireThat(full === base || full.startsWith(base + sep), 'Project path escapes checkout');
  return full;
}
function safeBytes(file) {
  const stat = lstatSync(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes, 'Expected bounded regular evidence');
  const data = readFileSync(file); requireThat(data.length <= maxBytes, 'Evidence byte limit exceeded'); return data;
}
function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  // GitHub action steps retain their own runtime tokens; project subprocesses
  // receive no GitHub/repository token from this wrapper.
  for (const name of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/i.test(name)
    || ['NODE_OPTIONS', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_PATH'].includes(name)) delete env[name];
  return env;
}
export function execute(command, args, { cwd, env = {}, timeout = 12 * 60 * 1000 } = {}) {
  const r = spawnSync(command, args, { cwd, env: childEnvironment(env), encoding: 'utf8', timeout, maxBuffer: maxBytes });
  if (r.error || r.status !== 0) {
    let diagnostic = null;
    try { const code = JSON.parse(r.stdout).error?.code; if (/^PULSE_[A-Z0-9_]+$/.test(code)) diagnostic = code; } catch {}
    throw Object.assign(new Error('Command did not complete successfully'), { exitCode: r.status, diagnostic, commandFailed: true });
  }
  return r.stdout;
}
const git = (cwd, ...args) => execute('git', args, { cwd }).trim();
const json = value => JSON.stringify(value, null, 2) + '\n';

export function normalizeInputs(input = {}) {
  const profiles = typeof input.profiles === 'string' ? JSON.parse(input.profiles) : input.profiles ?? ['local'];
  requireThat(Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 8
    && profiles.every(p => typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(p))
    && new Set(profiles).size === profiles.length, 'Select 1–8 distinct explicit profile names');
  const packageManager = input.package_manager ?? 'npm';
  requireThat(['npm', 'pnpm'].includes(packageManager), 'package_manager must be npm or pnpm');
  const installDirectory = projectRoot(input.install_directory ?? '.');
  const pulseVersion = input.pulse_version ?? '1.0.0-beta.10';
  requireThat(typeof pulseVersion === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pulseVersion), 'Pin an exact Pulse CLI version');
  const setupCommand = input.setup_command ?? '', buildCommand = input.build_command ?? '';
  requireThat([setupCommand, buildCommand].every(c => typeof c === 'string' && c.length <= 8192 && !c.includes('\0')), 'Invalid setup/build command');
  const compareInternal = input.compare_internal_beta10 ?? false;
  requireThat(typeof compareInternal === 'boolean', 'Comparison validation requires a boolean opt-in');
  const baselineBranch = input.baseline_branch ?? '';
  requireThat(typeof baselineBranch === 'string' && baselineBranch.length <= 256 && !/[\x00-\x20~^:?*\[\\]/.test(baselineBranch), 'Invalid approved baseline branch');
  return { profiles, packageManager, installDirectory, pulseVersion, setupCommand, buildCommand, compareInternal, baselineBranch };
}

// The metadata is orchestration evidence, not a replacement for capsule
// provenance. Git checkout and recipe identity remain separate claims.
export function capture({ checkout, output, task, discovery, metadata, inputs = {}, install = true }) {
  const options = normalizeInputs(inputs), root = realpathSync(checkout), out = resolve(output);
  requireThat(out !== root && !out.startsWith(root + sep), 'Stage reports outside the project checkout');
  requireThat(!existsSync(out), 'Capture output directory must be new');
  mkdirSync(out, { recursive: true });
  let phase = 'identity';
  const result = { schemaVersion: 'pulse.report-action.capture.v1', status: 'failed', phase, project: task.root,
    profile: task.profile, runId: metadata.runId, attempt: metadata.attempt, headRevision: discovery.headRevision,
    baselineRevision: discovery.baselineRevision, artifactName: `pulse-report-status-${task.id}-${sha256(task.profile).slice(0, 12)}-${metadata.runId}-${metadata.attempt}` };
  function finish() { writeFileSync(join(out, 'capture.json'), json(result), { flag: 'wx' }); return result; }
  try {
    revision(discovery.headRevision); revision(discovery.baselineRevision); revision(discovery.targetBaseRevision);
    revision(metadata.workflowRevision); revision(metadata.toolingRevision); positiveInteger(metadata.runId); positiveInteger(metadata.attempt);
    requireThat(['pull_request', 'push'].includes(metadata.event), 'Capture requires a pull_request or approved push event');
    requireThat(options.profiles.includes(task.profile), 'Task profile was not selected');
    requireThat(discovery.projects.some(p => p.id === task.id && p.root === task.root && p.status === task.status), 'Task differs from discovered project');
    requireThat(git(root, 'rev-parse', 'HEAD') === discovery.headRevision, 'Checkout is not the exact PR head');
    requireThat(git(root, 'status', '--porcelain', '--untracked-files=no') === '', 'Tracked checkout differs before capture');
    if (task.status === 'removed') { result.status = 'skipped'; result.reason = 'project-removed'; return finish(); }
    const project = contained(root, task.root), installRoot = contained(root, options.installDirectory);
    requireThat(project === installRoot || project.startsWith(installRoot + sep), 'Project is outside the dependency installation root');
    const config = contained(project, '.pulse/config.ts'); requireThat(lstatSync(config).isFile(), 'Missing regular project configuration');
    const lockName = options.packageManager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
    const lockPath = contained(installRoot, lockName), lockBytes = safeBytes(lockPath), lockSha256 = sha256(lockBytes);
    const packageFile = contained(installRoot, 'package.json'), pkg = JSON.parse(safeBytes(packageFile));
    phase = 'install'; result.phase = phase;
    let packageManagerVersion = execute('npm', ['--version'], { cwd: installRoot }).trim();
    if (options.packageManager === 'pnpm') {
      const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager || '');
      requireThat(match, 'pnpm requires an exact packageManager pin in package.json'); packageManagerVersion = match[1];
      if (install) execute('npm', ['exec', '--yes', '--package', `pnpm@${match[1]}`, '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd: installRoot });
    } else if (install) execute('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: installRoot });
    const req = createRequire(packageFile), cliRoot = dirname(dirname(req.resolve('@pulse-compute/cli')));
    const cliPackage = JSON.parse(safeBytes(join(cliRoot, 'package.json')));
    requireThat(cliPackage.name === '@pulse-compute/cli' && cliPackage.version === options.pulseVersion, 'Installed Pulse CLI differs from selected version');
    const cli = join(cliRoot, 'bin/pulse.js');
    const variables = { PULSE_PROJECT: project, PULSE_PROFILE: task.profile, PULSE_CLI: cli };
    phase = 'setup'; result.phase = phase;
    if (options.setupCommand) execute('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', options.setupCommand], { cwd: installRoot, env: variables });
    requireThat(sha256(safeBytes(lockPath)) === lockSha256 && git(root, 'status', '--porcelain', '--untracked-files=no') === '', 'Setup changed tracked checkout or lock');
    phase = 'selection'; result.phase = phase;
    const plan = JSON.parse(execute(process.execPath, [cli, 'build', project, '--profile', task.profile, '--plan', '--json'], { cwd: root }));
    requireThat(plan.status === 'ok' && plan.plan?.command === 'build' && plan.plan.project?.root === project, 'Invalid build selection');
    if (plan.plan.project.target !== 'native') { result.status = 'skipped'; result.reason = 'unsupported-javascript-target'; return finish(); }
    const provider = plan.plan.provider;
    phase = 'build'; result.phase = phase;
    const built = JSON.parse(options.buildCommand
      ? execute('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', options.buildCommand], { cwd: installRoot, env: variables })
      : execute(process.execPath, [cli, 'build', project, '--profile', task.profile, '--json'], { cwd: root }));
    requireThat(built.status === 'built' && built.project?.root === project && built.project.target === 'native'
      && built.provider === provider && built.project.selectedProfile?.name === task.profile, 'Build command did not emit a completed matching Native build');
    phase = 'report'; result.phase = phase;
    const report = execute(process.execPath, [cli, 'report', project, '--profile', task.profile, '--json'], { cwd: root });
    const capsule = JSON.parse(report);
    requireThat(capsule.kind === 'pulse.application-report' && capsule.context?.target === 'native'
      && capsule.context.profile === task.profile && capsule.context.host === provider && capsule.producer?.pulseVersion === options.pulseVersion,
    'Report does not match selected Native build context');
    const htmlName = `.pulse/reports/report-action-${metadata.runId}-${metadata.attempt}-${sha256(task.profile).slice(0, 12)}.html`;
    execute(process.execPath, [cli, 'report', project, '--profile', task.profile, '--html', '--out', htmlName], { cwd: root });
    const htmlFile = contained(project, htmlName); safeBytes(htmlFile);
    writeFileSync(join(out, 'head.json'), report, { flag: 'wx' }); copyFileSync(htmlFile, join(out, 'head.html'));
    requireThat(sha256(safeBytes(lockPath)) === lockSha256 && git(root, 'status', '--porcelain', '--untracked-files=no') === '', 'Build changed tracked checkout or lock');
    const execution = executionIdentity({ options, packageManagerVersion, packageBytes: safeBytes(packageFile), toolingRevision: metadata.toolingRevision });
    const executionSha256 = sha256(JSON.stringify(execution));
    const identity = { repository: metadata.repository, pullRequest: metadata.pullRequest,
      targetBaseRevision: discovery.targetBaseRevision, baselineRevision: discovery.baselineRevision, headRevision: discovery.headRevision,
      project: { root: task.root }, recipe: { profile: task.profile, provider, target: 'native', pulseVersion: cliPackage.version, lockSha256, executionSha256 },
      workflow: { path: metadata.workflowPath, revision: metadata.workflowRevision },
      run: { id: metadata.runId, attempt: metadata.attempt, event: metadata.event },
      baseline: { status: 'unavailable', revision: discovery.baselineRevision, reason: task.status === 'added' ? 'new-project' : 'not-requested' } };
    const files = [{ role: 'head-json', path: 'head.json' }, { role: 'head-html', path: 'head.html' }];
    const manifest = metadata.event === 'push'
      ? sealBaseline(out, { ...identity, workflow: { ...identity.workflow, id: metadata.workflowId }, branch: metadata.baselineBranch }, files)
      : sealBundle(out, identity, files);
    writeFileSync(join(out, 'manifest.json'), json(manifest), { flag: 'wx' });
    result.status = 'captured'; result.phase = 'complete'; result.artifactName = metadata.event === 'push' ? baselineArtifactName(manifest) : artifactName(manifest);
    result.recipe = manifest.recipe; result.execution = execution; result.toolingRevision = metadata.toolingRevision;
    result.files = manifest.files; result.baseline = manifest.baseline;
  } catch (error) {
    result.phase = phase; result.diagnostic = /^PULSE_[A-Z0-9_]+$/.test(error.diagnostic || '') ? error.diagnostic : null;
    result.failureCode = result.diagnostic ?? `REPORT_ACTION_${phase.toUpperCase()}_FAILED`;
    result.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : null;
    // No raw stdout/stderr, project values or stack paths are uploaded on failure.
    for (const name of ['head.json', 'head.html', 'manifest.json']) if (existsSync(join(out, name))) {
      // Incomplete evidence is not staged as a successful report bundle.
      // This directory is new and owned by this capture invocation.
      rmSync(join(out, name));
    }
  }
  return finish();
}

export function executionIdentity({ options, packageManagerVersion, packageBytes, toolingRevision }) {
  return { packageManager: options.packageManager, packageManagerVersion, node: process.version,
    packageSha256: sha256(packageBytes), setupSha256: sha256(options.setupCommand),
    buildSha256: sha256(options.buildCommand || 'pulse build [project] --profile [profile] --json'),
    toolingRevision, dependencyLifecycleScripts: false };
}
