import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover } from '../src/discover.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pulse-report-discovery-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const put = (path, value = '// tracked configuration\n') => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), value); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  return { cwd, git, put, commit };
}

test('project source changes count outside .pulse; unrelated projects are skipped', t => {
  const f = fixture(t); f.put('apps/a/.pulse/config.ts'); f.put('apps/b/.pulse/config.ts');
  const base = f.commit(); f.put('apps/a/src/route.ts', 'changed'); const head = f.commit();
  assert.deepEqual(discover({ ...f, base, head }).projects.map(p => p.root), ['apps/a']);
});
test('shared files and root lock changes conservatively select every project', t => {
  const f = fixture(t); f.put('a/.pulse/config.ts'); f.put('b/.pulse/config.ts'); const base = f.commit();
  f.put('pnpm-lock.yaml', 'lock'); const head = f.commit();
  const result = discover({ ...f, base, head });
  assert.deepEqual(result.projects.map(p => p.root), ['a', 'b']);
  assert.ok(result.projects.every(p => p.reason === 'shared-input-change'));
});
test('discovery considers both trees for additions and removals', t => {
  const f = fixture(t); f.put('old/.pulse/config.ts'); const base = f.commit();
  rmSync(join(f.cwd, 'old'), { recursive: true }); f.put('new/.pulse/config.ts'); const head = f.commit();
  assert.deepEqual(discover({ ...f, base, head }).projects.map(p => [p.root, p.status]), [['new', 'added'], ['old', 'removed']]);
});
test('renames preserve both old and new roots and spaces in paths', t => {
  const f = fixture(t); f.put('old name/.pulse/config.ts'); const base = f.commit();
  renameSync(join(f.cwd, 'old name'), join(f.cwd, 'new name')); const head = f.commit();
  assert.deepEqual(discover({ ...f, base, head }).projects.map(p => p.root), ['new name', 'old name']);
});
test('nested project source changes select its containing parent too', t => {
  const f = fixture(t); f.put('.pulse/config.ts'); f.put('nested/.pulse/config.ts'); const base = f.commit();
  f.put('nested/source.ts', 'change'); const head = f.commit();
  assert.deepEqual(discover({ ...f, base, head }).projects.map(p => p.root), ['.', 'nested']);
});
test('a root project does not hide shared lock changes from nested projects', t => {
  const f = fixture(t); f.put('.pulse/config.ts'); f.put('nested/.pulse/config.ts'); const base = f.commit();
  f.put('package-lock.json', '{}'); const head = f.commit();
  assert.deepEqual(discover({ ...f, base, head }).projects.map(p => p.root), ['.', 'nested']);
});
test('uses merge-base rather than unrelated new base-branch changes', t => {
  const f = fixture(t); f.put('a/.pulse/config.ts'); f.put('b/.pulse/config.ts'); const ancestor = f.commit();
  f.git('checkout', '-qb', 'pr'); f.put('a/source.ts', 'PR'); const head = f.commit();
  f.git('checkout', '-q', 'main'); f.put('b/source.ts', 'base-only'); const base = f.commit();
  const result = discover({ ...f, base, head });
  assert.equal(result.baselineRevision, ancestor); assert.equal(result.targetBaseRevision, base);
  assert.deepEqual(result.projects.map(p => p.root), ['a']);
});
test('untracked outputs are not projects; identical trees skip all builds', t => {
  const f = fixture(t); f.put('README.md', 'readme'); const base = f.commit(); f.put('fake/.pulse/config.ts');
  assert.deepEqual(discover({ ...f, base, head: base }).projects, []);
});
test('optional ignore prefixes are literal and bounded; no code is loaded', t => {
  const f = fixture(t); f.put('app/.pulse/config.ts', "throw new Error('must never execute')"); const base = f.commit();
  f.put('docs/note.md', 'note'); const head = f.commit();
  assert.deepEqual(discover({ ...f, base, head, ignorePrefixes: ['docs'] }).projects, []);
  assert.throws(() => discover({ ...f, base, head, ignorePrefixes: ['../docs'] }), /Unsafe/);
  assert.throws(() => discover({ ...f, base: 'main', head }), /full Git revision/);
});
test('tracked symlink configurations reject instead of loading or following them', t => {
  const f = fixture(t); f.put('app/real.ts'); f.put('README.md', 'base'); const base = f.commit();
  mkdirSync(join(f.cwd, 'app/.pulse')); symlinkSync('../real.ts', join(f.cwd, 'app/.pulse/config.ts'));
  const head = f.commit();
  assert.throws(() => discover({ ...f, base, head }), /regular tracked file/);
});
