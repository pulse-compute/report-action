import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat, revision, safePath, projectRoot, projectId } from './contracts.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function configurations(cwd, commit) {
  const roots = new Set();
  for (const row of git(cwd, ['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), name = row.slice(tab + 1);
    if (name !== '.pulse/config.ts' && !name.endsWith('/.pulse/config.ts')) continue;
    safePath(name);
    requireThat(/^(100644|100755) blob [a-f0-9]+$/.test(row.slice(0, tab)), 'Pulse configuration must be a regular tracked file');
    roots.add(name === '.pulse/config.ts' ? '.' : name.slice(0, -'/.pulse/config.ts'.length));
  }
  return roots;
}
const contains = (root, path) => root === '.' || path.startsWith(root + '/');

// Reads Git trees only. Never imports a project configuration or runs its code.
export function discover({ cwd, base, head, ignorePrefixes = [] }) {
  revision(base); revision(head);
  requireThat(Array.isArray(ignorePrefixes), 'ignorePrefixes must be an array');
  ignorePrefixes.forEach(safePath);
  for (const commit of [base, head]) {
    requireThat(git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() === commit, 'Revision is not an exact commit');
  }
  const baseline = revision(git(cwd, ['merge-base', base, head]).trim());
  const before = configurations(cwd, baseline), after = configurations(cwd, head);
  const roots = [...new Set([...before, ...after])].sort();
  requireThat(roots.length <= 256, 'Project discovery exceeds 256 roots');
  const changed = git(cwd, ['diff', '--name-only', '--no-renames', '-z', baseline, head, '--']).split('\0').filter(Boolean);
  changed.forEach(safePath);
  const ignored = path => ignorePrefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'));
  const relevant = changed.filter(path => !ignored(path));
  // Shared sources, root manifests/locks and files outside known projects may
  // affect any project. Without a dependency graph, rebuilding all is deliberate.
  // A root project must not swallow shared-lock/setup changes that can also
  // affect nested projects. Outside non-root project ownership, invalidate all.
  const shared = relevant.some(path => !roots.filter(root => root !== '.').some(root => contains(root, path)));
  const projects = roots.filter(root => shared || relevant.some(path => contains(root, path)))
    .map(root => ({ id: projectId(root), root: projectRoot(root),
      status: !before.has(root) ? 'added' : !after.has(root) ? 'removed' : 'existing',
      reason: shared ? 'shared-input-change' : 'project-change' }));
  return { schemaVersion: 'pulse.report-action.discovery.v1', targetBaseRevision: base,
    baselineRevision: baseline, headRevision: head, changedFileCount: changed.length,
    ignoredFileCount: changed.length - relevant.length, projects };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head, cwd = '.'] = process.argv.slice(2);
  console.log(JSON.stringify(discover({ cwd, base, head }), null, 2));
}
