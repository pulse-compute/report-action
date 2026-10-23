import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publish, marker, escapeLabel } from '../src/publisher.mjs';
import { publisherPolicy, sourceSnapshot } from '../src/publisher-source.mjs';
import { reportName, statusName, evidenceReader } from '../src/publisher-artifacts.mjs';
import { sealBaseline, baselineArtifactName } from '../src/baseline-evidence.mjs';
import { sealBundle } from '../src/evidence.mjs';
import { execute } from '../src/capture.mjs';
import { sha256 } from '../src/contracts.mjs';
import { publisherClient } from '../src/github.mjs';
import { presentationName } from '../src/presentation.mjs';

const sha = digit => digit.repeat(40), now = Date.parse('2026-10-23T05:00:00Z');
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
async function harness(t, { fork = false, comparison = false, root = 'apps/app', conclusion = 'success', attempt = 1, added = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'publisher-test-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repository = 'owner/repo', headRepo = { id: fork ? 2 : 1, full_name: fork ? 'contributor/repo' : repository };
  const run = { id: 101, workflow_id: 7, run_number: 9, run_attempt: attempt, event: 'pull_request', status: 'completed', conclusion,
    repository: { full_name: repository }, head_repository: headRepo, head_branch: 'feature', head_sha: sha('3'), path: '.github/workflows/pulse.yml', pull_requests: [],
    referenced_workflows: [{ path: `owner/tooling/.github/workflows/reports.yml@${sha('5')}`, sha: sha('5') }] };
  const pr = { number: 12, state: 'open', merge_commit_sha: sha('4'), base: { sha: sha('1'), repo: { full_name: repository } }, head: { sha: run.head_sha, ref: 'feature', repo: headRepo } };
  const policy = { schemaVersion: 'pulse.report-action.publisher-policy.v1', captureWorkflow: run.path,
    tooling: { repository: 'owner/tooling', workflow: '.github/workflows/reports.yml', revision: sha('5') },
    inputs: { profiles: ['ci'], compare_internal_beta10: comparison }, providers: { ci: 'node' }, nodeVersion: 'v24.18.0', npmVersion: '11.16.0' };
  const blobs = new Map();
  function entry(path, content, mode = '100644') {
    const bytes = Buffer.from(content), id = createHash('sha1').update(bytes).digest('hex');
    blobs.set(id, { sha: id, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
    return { path, mode, type: 'blob', sha: id, size: bytes.length };
  }
  const common = [entry(`${root}/.pulse/config.ts`, "throw new Error('publisher must never execute config')"),
    entry('package.json', JSON.stringify({ devDependencies: { '@pulse-compute/cli': '1.0.0-beta.10' } })),
    entry('package-lock.json', JSON.stringify({ packages: { 'node_modules/@pulse-compute/cli': { version: '1.0.0-beta.10' } } }))];
  const before = [...(added ? common.filter(e => !e.path.endsWith('/.pulse/config.ts')) : common), entry(`${root}/src.ts`, 'before')], after = [...common, entry(`${root}/src.ts`, 'after')];
  const artifacts = [], archives = new Map(), directories = new Map(), comments = [], mutations = [], calls = [];
  const state = { pr, run, associated: [{ number: pr.number }], openPulls: [], latestRuns: [run], comments, artifacts, before, after, blobs, hook: null, extra: new Map() };
  const api = {
    async json(path, options) {
      calls.push({ path, options }); if (state.hook) await state.hook(path, options);
      if (state.extra.has(path)) return structuredClone(state.extra.get(path));
      if (options?.method) { mutations.push({ path, ...options }); return { id: 88 }; }
      if (path === '') return { full_name: repository, default_branch: 'main' };
      if (path === `/actions/runs/${run.id}`) return structuredClone(state.run);
      if (path.startsWith('/actions/workflows/') && !path.includes('/runs?')) { assert.equal(path, '/actions/workflows/pulse.yml'); return { id: 7, path: policy.captureWorkflow }; }
      if (path.startsWith('/commits/') && path.includes('/pulls?')) return state.associated;
      if (path.startsWith('/pulls?')) return state.openPulls;
      if (path.startsWith('/pulls/')) return structuredClone(state.pr);
      if (path.startsWith('/actions/workflows/7/runs?')) return { workflow_runs: structuredClone(state.latestRuns) };
      if (path === `/git/commits/${sha('4')}`) return { sha: sha('4'), parents: [{ sha: sha('1') }, { sha: sha('3') }] };
      if (path.startsWith('/compare/')) return { merge_base_commit: { sha: sha('2') } };
      if (path === `/git/trees/${sha('2')}?recursive=1`) return { tree: state.before, truncated: false };
      if (path === `/git/trees/${sha('3')}?recursive=1`) return { tree: state.after, truncated: false };
      if (path.startsWith('/git/blobs/')) return state.blobs.get(path.split('/').at(-1));
      if (path.startsWith(`/actions/runs/${run.id}/artifacts?`)) return { artifacts: structuredClone(artifacts) };
      if (path.startsWith(`/issues/${pr.number}/comments?`)) return comments;
      throw Error('Unexpected mocked endpoint: ' + path);
    },
    async archive(id) { calls.push({ archive: id }); return archives.get(id); },
  };
  const snapshot = await sourceSnapshot({ api, pr, run, repository, policy: publisherPolicy(policy) }), task = { ...snapshot.discovery.projects[0], profile: 'ci' };
  const expected = await snapshot.recipe('ci', 'node'); let serial = 0;
  function zipDirectory(dir, extraEntries = null) {
    const zip = join(temp, `zip-${serial++}.zip`);
    execute('python3', ['-I', '-c', `import zipfile,sys,json,os,stat\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for n in os.listdir(sys.argv[2]):\n  p=os.path.join(sys.argv[2],n)\n  if os.path.islink(p):\n   i=zipfile.ZipInfo(n);i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(i,os.readlink(p))\n  else: z.write(p,n)\n for n,v in json.loads(sys.argv[3]): z.writestr(n,v)`, zip, dir, JSON.stringify(extraEntries ?? [])]);
    return readFileSync(zip);
  }
  function upload(dir, name, extraEntries) {
    const bytes = zipDirectory(dir, extraEntries), id = 200 + serial;
    const a = { id, name, size_in_bytes: bytes.length, digest: 'sha256:' + sha256(bytes), expired: false, expires_at: '2027-01-01', workflow_run: { id: run.id, head_sha: run.head_sha } };
    artifacts.push(a); archives.set(id, bytes); directories.set(id, dir); return a;
  }
  function view(bundle, role, bytes) {
    bytes ??= readFileSync(join(directories.get(bundle.id), role === 'report' ? 'head.html' : 'compare.html'));
    const id = 10000 + serial++;
    const a = { id, name: presentationName(bundle.name, role), size_in_bytes: bytes.length, digest: 'sha256:' + sha256(bytes), expired: false,
      expires_at: '2027-01-01', workflow_run: { id: run.id, head_sha: run.head_sha } };
    artifacts.push(a); archives.set(id, bytes); return a;
  }
  function bundle({ compare = false, status = 'captured', missingBaseline = null, mutateManifest, mutateCapture, extraEntries, mutateFiles } = {}) {
    const dir = join(temp, 'bundle-' + serial++); mkdirSync(dir);
    const name = status === 'captured' ? reportName(task, expected.recipe, run) + (compare ? '-comparison' : '') : statusName(task, run) + (compare ? '-comparison' : '');
    let c = { schemaVersion: 'pulse.report-action.capture.v1', status, phase: 'complete', project: root, profile: 'ci', runId: run.id, attempt: run.run_attempt,
      headRevision: run.head_sha, baselineRevision: sha('2'), artifactName: name, ...(compare ? { comparison: true } : {}) };
    if (status === 'captured') {
      const capsule = { kind: 'pulse.application-report', context: { profile: 'ci', host: 'node', target: 'native' }, producer: { pulseVersion: '1.0.0-beta.10' }, provenance: { revision: null } };
      writeFileSync(join(dir, 'head.json'), JSON.stringify(capsule)); writeFileSync(join(dir, 'head.html'), '<script>throw new Error("never evaluate HTML")</script>');
      const files = [{ role: 'head-json', path: 'head.json' }, { role: 'head-html', path: 'head.html' }];
      const baseline = { status: compare && !missingBaseline ? 'available' : 'unavailable', revision: sha('2'), reason: compare ? missingBaseline : task.status === 'added' ? 'new-project' : 'not-requested' };
      const identity = { repository, pullRequest: pr.number, targetBaseRevision: sha('1'), baselineRevision: sha('2'), headRevision: run.head_sha,
        project: { root }, recipe: expected.recipe, workflow: { path: run.path, revision: sha('4') }, run: { id: run.id, attempt: run.run_attempt, event: 'pull_request' }, baseline };
      if (compare) {
        identity.comparisonAdapter = 'internal-beta10-validation-only';
        if (!missingBaseline) {
          const compatibility = 'unknown', comparisonHash = { algorithm: 'sha256', value: 'a'.repeat(64) };
          writeFileSync(join(dir, 'base.json'), JSON.stringify(capsule)); writeFileSync(join(dir, 'base.html'), '<html>baseline</html>');
          writeFileSync(join(dir, 'compare.json'), JSON.stringify({ kind: 'pulse.report-comparison', comparisonVersion: 1, compatibility: { status: compatibility }, comparisonHash }));
          writeFileSync(join(dir, 'compare.html'), '<html>comparison</html>');
          const receipt = { purpose: 'validation-only', adapter: 'internal-beta10-validation', packageVersion: '1.0.0-beta.10', compatibility, comparisonHash,
            pinSha256: sha256(readFileSync(fileURLToPath(new URL('../validation/internal-compare-pin.json', import.meta.url)))),
            inputs: { beforeSha256: sha256(readFileSync(join(dir, 'base.json'))), afterSha256: sha256(readFileSync(join(dir, 'head.json'))) },
            files: ['compare.json', 'compare.html'].map(path => ({ path, bytes: readFileSync(join(dir, path)).length, sha256: sha256(readFileSync(join(dir, path))) })) };
          writeFileSync(join(dir, 'compare-shim-receipt.json'), JSON.stringify(receipt));
          files.push(...[['base-json', 'base.json'], ['base-html', 'base.html'], ['compare-json', 'compare.json'], ['compare-html', 'compare.html'], ['compare-receipt', 'compare-shim-receipt.json']].map(([role, path]) => ({ role, path })));
          identity.compatibility = compatibility; identity.baselineSource = { status: 'rebuilt', revision: sha('2'), recipe: expected.recipe, execution: expected.execution }; c.compatibility = compatibility;
        }
      }
      const m = sealBundle(dir, identity, files); if (mutateManifest) mutateManifest(m);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
      c = { ...c, recipe: expected.recipe, execution: expected.execution, toolingRevision: sha('5'), files: m.files, baseline: m.baseline };
    } else if (status === 'failed') c.failureCode = 'REPORT_ACTION_BUILD_FAILED';
    else c.reason = 'unsupported-javascript-target';
    if (mutateCapture) mutateCapture(c);
    writeFileSync(join(dir, 'capture.json'), JSON.stringify(c)); if (mutateFiles) mutateFiles(dir);
    return upload(dir, name, extraEntries);
  }
  const args = { api, repository, policy, event: { action: 'completed', repository: { full_name: repository }, workflow_run: { id: run.id, run_attempt: run.run_attempt, event: 'pull_request' } },
    context: { eventName: 'workflow_run', ref: 'refs/heads/main' }, stage: join(temp, 'stage'), now: () => now };
  async function invoke(overrides = {}) { return publish({ ...args, stage: join(temp, 'stage-' + serial++), ...overrides }); }
  return { temp, api, args, invoke, state, task, expected, snapshot, run, pr, policy, bundle, upload, view, archives, artifacts, mutations, calls, comments };
}

test('same-repository and fork PRs use authenticated commit association and GitHub-issued report links', async t => {
  for (const fork of [false, true]) {
    const f = await harness(t, { fork }); const a = f.bundle(); const result = await f.invoke();
    assert.equal(result.status, 'created'); assert.equal(f.mutations.length, 1); assert.match(result.body, new RegExp(`/artifacts/${a.id}\\)`));
    assert.match(result.body, /sign-in/); assert.match(result.body, /baseline unavailable: not-requested/);
    assert.equal(f.run.pull_requests.length, 0); // No artifact PR-number routing.
  }
});
test('matching bot-owned comment is updated; human/other-bot markers are never overwritten; repeated identical result is a no-op', async t => {
  const f = await harness(t); f.bundle(); const preview = await f.invoke({ dryRun: true });
  assert.equal(f.mutations.length, 0);
  f.comments.push({ id: 88, user: bot, body: preview.body.replace('sign-in', 'old-sign-in') }, { id: 89, user: { id: 1, login: 'person', type: 'User' }, body: marker });
  assert.equal((await f.invoke()).status, 'updated'); assert.equal(f.mutations[0].method, 'PATCH'); assert.equal(f.mutations[0].path, '/issues/comments/88');
  f.comments[0].body = preview.body; assert.equal((await f.invoke()).status, 'unchanged'); assert.equal(f.mutations.length, 1);
});
test('user-spoofed marker does not own the bot comment; duplicate bot markers fail closed', async t => {
  const f = await harness(t); f.bundle(); const preview = await f.invoke({ dryRun: true });
  f.comments.push({ id: 87, user: { ...bot, id: 1, type: 'User' }, body: preview.body });
  assert.equal((await f.invoke()).status, 'created'); assert.equal(f.mutations[0].method, 'POST');
  f.comments.push({ id: 88, user: bot, body: preview.body }, { id: 89, user: bot, body: preview.body });
  await assert.rejects(f.invoke(), /Multiple bot/); assert.equal(f.mutations.length, 1);
});
test('stale heads, closed/deleted PR association, ambiguous association and newer pending run cannot mutate', async t => {
  for (const change of [f => f.state.pr.head.sha = sha('6'), f => f.state.pr.state = 'closed', f => f.state.associated = [],
    f => f.state.latestRuns.push({ ...f.run, id: 102, run_number: 10, status: 'queued', conclusion: null })]) {
    const f = await harness(t); f.bundle(); change(f); const r = await f.invoke(); assert.equal(r.status, 'ignored'); assert.equal(f.mutations.length, 0);
  }
  const f = await harness(t); f.state.associated.push({ number: 13 }); await assert.rejects(f.invoke(), /Ambiguous PR/); assert.equal(f.mutations.length, 0);
});
test('run attempts and latest head are rechecked immediately before writing after archive download', async t => {
  for (const change of [f => f.state.pr.head.sha = sha('6'), f => f.state.run = { ...f.run, run_attempt: 2 }]) {
    const f = await harness(t); f.bundle();
    f.state.hook = path => { if (path.startsWith('/issues/12/comments?')) change(f); };
    assert.equal((await f.invoke()).status, 'ignored'); assert.equal(f.mutations.length, 0);
  }
  const f = await harness(t); f.state.run = { ...f.run, run_attempt: 2 }; assert.equal((await f.invoke()).reason, 'superseded-attempt');
});
test('a fresh rerun replaces the older attempt but never a newer marked result', async t => {
  const f = await harness(t, { attempt: 2 }); f.bundle(); const preview = await f.invoke({ dryRun: true });
  f.comments.push({ id: 88, user: bot, body: preview.body.replace('"attempt":2', '"attempt":1') });
  assert.equal((await f.invoke()).status, 'updated'); f.comments[0].body = preview.body.replace('"attempt":2', '"attempt":3');
  assert.equal((await f.invoke()).reason, 'newer-comment'); assert.equal(f.mutations.length, 1);
});
test('expired and missing reports stay explicit and receive no artifact links', async t => {
  const f = await harness(t); f.bundle().expired = true;
  const r = await f.invoke(); assert.match(r.body, /artifact expired/); assert.ok(!r.body.includes('/artifacts/')); assert.equal(f.calls.some(c => c.archive), false);
  const g = await harness(t); const missing = await g.invoke(); assert.match(missing.body, /missing report evidence/);
});
test('failed workflow preserves bounded failed capture state without requiring whole-run success', async t => {
  const f = await harness(t, { conclusion: 'failure' }); f.bundle({ status: 'failed' });
  assert.match((await f.invoke()).body, /failed: REPORT&#95;ACTION&#95;BUILD&#95;FAILED/);
  const g = await harness(t, { conclusion: 'failure' }); g.bundle(); assert.match((await g.invoke()).body, /evidence\.zip/);
});
test('forged PR/repository/head/recipe/attempt and source workflow identities reject with no write', async t => {
  for (const mutate of [m => m.pullRequest++, m => m.repository = 'attacker/repo', m => m.headRevision = sha('6'), m => m.baselineRevision = sha('6'),
    m => m.workflow.revision = sha('6'), m => m.run.attempt++, m => m.recipe.provider = 'fastly', m => m.recipe.lockSha256 = 'f'.repeat(64)]) {
    const f = await harness(t); f.bundle({ mutateManifest: mutate }); await assert.rejects(f.invoke()); assert.equal(f.mutations.length, 0);
  }
  const f = await harness(t); f.bundle(); f.state.run.referenced_workflows[0].sha = sha('6'); await assert.rejects(f.invoke(), /tooling differs/); assert.equal(f.mutations.length, 0);
});
test('archive/file tampering, traversal, duplicates, extra code and symlinks reject without executing content', async t => {
  for (const options of [{ extraEntries: [['../escape', 'bad']] }, { extraEntries: [['head.json', '{}']] }, { extraEntries: [['run.mjs', 'throw Error("never run")']] },
    { mutateFiles: dir => writeFileSync(join(dir, 'head.html'), 'tampered') },
    { mutateFiles: dir => { rmSync(join(dir, 'head.html')); symlinkSync(join(dir, 'head.json'), join(dir, 'head.html')); } }]) {
    const f = await harness(t); f.bundle(options); await assert.rejects(f.invoke()); assert.equal(f.mutations.length, 0);
  }
  const f = await harness(t); const a = f.bundle(); f.archives.set(a.id, Buffer.from('wrong archive')); await assert.rejects(f.invoke(), /Archive digest/); assert.equal(f.mutations.length, 0);
});
test('one complete evidence archive preserves comparison compatibility; absent baseline has no compare HTML link', async t => {
  const f = await harness(t, { comparison: true }); const head = f.bundle(), compared = f.bundle({ compare: true });
  const r = await f.invoke(); assert.ok(!r.body.includes(`/artifacts/${head.id}`)); assert.ok(r.body.includes(`/artifacts/${compared.id}`)); assert.match(r.body, /validation comparison: unknown/);
  const g = await harness(t, { comparison: true, added: true }); g.bundle(); g.bundle({ compare: true, missingBaseline: 'new-project' });
  const missing = await g.invoke(); assert.match(missing.body, /baseline unavailable: new-project/); assert.equal((missing.body.match(/\/artifacts\//g) ?? []).length, 1);
});
test('trusted policy—not plan artifacts—controls recipes; labels and mentions are escaped', async t => {
  const f = await harness(t, { root: 'apps/a|[x]@team' }); f.bundle(); const r = await f.invoke();
  assert.ok(!r.body.includes('a|[x]@team')); assert.ok(r.body.includes('&#64;team')); assert.ok(!escapeLabel('[x](javascript:alert(1))').includes('[x]('));
  const g = await harness(t); g.bundle(); g.policy.providers.ci = 'fastly'; const mismatch = await g.invoke(); assert.match(mismatch.body, /missing report evidence/); assert.ok(!mismatch.body.includes('/artifacts/'));
});
test('publisher context, workflow ID, source repository and test-merge parent identity fail closed', async t => {
  const f = await harness(t); f.bundle();
  await assert.rejects(f.invoke({ context: { eventName: 'pull_request', ref: 'refs/heads/main' } }), /workflow_run/);
  await assert.rejects(f.invoke({ context: { eventName: 'workflow_run', ref: 'refs/pull/12/merge' } }), /default branch/);
  f.state.run.workflow_id = 8; await assert.rejects(f.invoke(), /workflow ID/); assert.equal(f.mutations.length, 0);
});
test('privileged client restricts endpoints and never forwards authorization to signed storage', async () => {
  const calls = [], api = publisherClient('owner/repo', 'private-token', async (url, options) => {
    calls.push({ url, options }); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example/signed' } }) : new Response('zip');
  });
  assert.equal((await api.archive(1)).toString(), 'zip'); assert.equal(calls[1].options.headers, undefined);
  await assert.rejects(api.json('https://attacker.example'), /Invalid API path/);
  await assert.rejects(api.json('/../outside'), /Invalid API path/);
});

test('ambiguous artifacts, malformed bot state, invalid retention and a changed base stop publication', async t => {
  const f = await harness(t); const a = f.bundle(); f.artifacts.push({ ...a, id: a.id + 1 }); await assert.rejects(f.invoke(), /Ambiguous evidence/); assert.equal(f.mutations.length, 0);
  const g = await harness(t); g.bundle(); g.comments.push({ id: 88, user: bot, body: marker + '\n<!-- bad state -->' });
  await assert.rejects(g.invoke(), /Unrecognized bot/); assert.equal(g.mutations.length, 0);
  const h = await harness(t); h.bundle().expires_at = null; await assert.rejects(h.invoke(), /retention/); assert.equal(h.mutations.length, 0);
  const j = await harness(t); j.bundle(); j.state.hook = path => { if (path.startsWith('/issues/12/comments?')) j.state.pr.base.sha = sha('6'); };
  assert.equal((await j.invoke()).status, 'ignored'); assert.equal(j.mutations.length, 0);
});
test('archive expansion and aggregate download budgets reject before a comment can be written', async t => {
  const f = await harness(t); const a = f.bundle(); a.size_in_bytes = 129 * 1024 * 1024;
  await assert.rejects(f.invoke(), /metadata differs/); assert.equal(f.mutations.length, 0); assert.equal(f.calls.some(c => c.archive), false);
  const budgeted = await harness(t); const first = budgeted.bundle(), second = budgeted.bundle(), third = budgeted.bundle();
  const boundedRead = evidenceReader({ api: budgeted.api, stage: budgeted.temp, now: () => now, budget: first.size_in_bytes + second.size_in_bytes });
  await boundedRead(first, budgeted.run); await boundedRead(second, budgeted.run);
  await assert.rejects(boundedRead(third, budgeted.run), /budget exceeded/);
  const g = await harness(t);
  // Sparse ZIP metadata advertises an oversized expanded HTML member without
  // allocating it. The extractor must reject sizes before writing any member.
  const path = join(g.temp, 'oversize.zip');
  execute('python3', ['-I', '-c', `import zipfile,sys,struct\np=sys.argv[1]\nwith zipfile.ZipFile(p,'w') as z:\n for n in ['head.json','head.html','manifest.json','capture.json']:z.writestr(n,'{}')\nb=bytearray(open(p,'rb').read());at=b.find(b'PK\\x01\\x02');struct.pack_into('<I',b,at+24,65*1024*1024);open(p,'wb').write(b)`, path]);
  const bytes = readFileSync(path), artifact = { id: 999, workflow_run: { id: g.run.id, head_sha: g.run.head_sha }, expired: false, expires_at: '2027-01-01', size_in_bytes: bytes.length, digest: 'sha256:' + sha256(bytes) };
  const read = evidenceReader({ api: { archive: async () => bytes }, stage: g.temp, now: () => now });
  await assert.rejects(read(artifact, g.run));
});
test('the production HTTP client permits the authenticated three-dot comparison path', async () => {
  const api = publisherClient('owner/repo', 'token', async (url, options) => {
    assert.ok(url.endsWith(`/compare/${sha('1')}...${sha('3')}?per_page=1`));
    return new Response(JSON.stringify({ merge_base_commit: { sha: sha('2') } }));
  });
  assert.equal((await api.json(`/compare/${sha('1')}...${sha('3')}?per_page=1`)).merge_base_commit.sha, sha('2'));
});


test('retained baseline links require a successful approved push, matching bytes and a current attempt', async t => {
  const f = await harness(t, { comparison: true }); f.bundle();
  const cached = join(f.temp, 'approved-push'); mkdirSync(cached);
  const capsule = { kind: 'pulse.application-report', context: { profile: 'ci', host: 'node', target: 'native' }, producer: { pulseVersion: '1.0.0-beta.10' }, provenance: { revision: null } };
  writeFileSync(join(cached, 'head.json'), JSON.stringify(capsule)); writeFileSync(join(cached, 'head.html'), '<html>baseline</html>'); writeFileSync(join(cached, 'capture.json'), '{}');
  const producer = { ...f.run, id: 303, run_attempt: 2, event: 'push', head_sha: sha('2'), head_branch: 'main' };
  const manifest = sealBaseline(cached, { repository: 'owner/repo', headRevision: sha('2'), project: { root: f.task.root }, recipe: f.expected.recipe,
    workflow: { id: 7, path: f.run.path, revision: sha('2') }, branch: 'main', run: { id: 303, attempt: 2, event: 'push' } },
    [{ role: 'head-json', path: 'head.json' }, { role: 'head-html', path: 'head.html' }]);
  writeFileSync(join(cached, 'manifest.json'), JSON.stringify(manifest));
  const artifact = f.upload(cached, baselineArtifactName(manifest)); artifact.workflow_run = { id: 303, head_sha: sha('2') };
  f.state.extra.set('/actions/runs/303', producer); f.state.extra.set(`/actions/artifacts/${artifact.id}`, artifact);
  f.bundle({ compare: true, mutateManifest: m => m.baselineSource = { status: 'retained', runId: 303, attempt: 2, artifactId: artifact.id,
    archiveDigest: artifact.digest, workflowId: 7, workflowPath: f.run.path, revision: sha('2'), branch: 'main', recipe: f.expected.recipe } });
  assert.match((await f.invoke()).body, /validation comparison: unknown/); assert.equal(f.mutations.length, 1);
  producer.head_repository = { id: 3, full_name: 'attacker/repo' };
  await assert.rejects(f.invoke(), /Ineligible baseline producer/); assert.equal(f.mutations.length, 1);
  producer.head_repository = f.run.head_repository; producer.run_attempt = 3;
  await assert.rejects(f.invoke(), /binding differs/); assert.equal(f.mutations.length, 1);
  producer.run_attempt = 2; artifact.expired = true;
  await assert.rejects(f.invoke(), /expired/); assert.equal(f.mutations.length, 1);
});

test('removed projects and no-op source trees retain explicit states without resolving build recipes', async t => {
  const f = await harness(t); f.state.after = f.state.after.filter(e => !e.path.endsWith('/.pulse/config.ts'));
  f.bundle({ status: 'skipped', mutateCapture: c => c.reason = 'project-removed' });
  const removed = await f.invoke(); assert.match(removed.body, /skipped: project-removed/); assert.ok(!removed.body.includes('/artifacts/'));
  const g = await harness(t); g.state.after = g.state.before; const noop = await g.invoke();
  assert.match(noop.body, /No affected Pulse projects/); assert.equal(g.calls.some(c => c.archive), false);
});

test('forks with empty run and base-commit associations resolve only an exact authenticated owner/branch/repository/head', async t => {
  const f = await harness(t, { fork: true }); f.state.associated = []; f.state.openPulls = [f.pr]; f.bundle();
  assert.equal((await f.invoke()).status, 'created');
  assert.ok(f.calls.some(c => c.path?.startsWith('/pulls?state=open&head=contributor%3Afeature')));
  f.state.pr.head.ref = 'other-branch'; assert.equal((await f.invoke()).status, 'ignored'); assert.equal(f.mutations.length, 1);
});

test('three downloads expose exact raw HTML and one complete evidence ZIP', async t => {
  const f = await harness(t, { comparison: true });
  const head = f.bundle(), comparison = f.bundle({ compare: true });
  const report = f.view(head, 'report'), compare = f.view(comparison, 'compare');
  const r = await f.invoke();
  assert.ok(r.body.includes(`[report.html](https://github.com/owner/repo/actions/runs/101/artifacts/${report.id})`));
  assert.ok(r.body.includes(`[compare.html](https://github.com/owner/repo/actions/runs/101/artifacts/${compare.id})`));
  assert.ok(r.body.includes(`[evidence.zip](https://github.com/owner/repo/actions/runs/101/artifacts/${comparison.id})`));
  assert.equal((r.body.match(/\/artifacts\//g) ?? []).length, 3);
  assert.equal(r.rows, undefined); // Live result contains the comment, not raw HTML.
  assert.equal(f.mutations.length, 1);
});
test('raw HTML digest, transport bytes, run identity and duplicate names fail closed', async t => {
  for (const kind of ['digest', 'transport', 'run', 'duplicate']) {
    const f = await harness(t); const bundle = f.bundle();
    const a = f.view(bundle, 'report', kind === 'digest' ? Buffer.from('wrong HTML') : undefined);
    if (kind === 'transport') f.archives.set(a.id, Buffer.alloc(a.size_in_bytes, 120));
    if (kind === 'run') a.workflow_run.id++;
    if (kind === 'duplicate') f.view(bundle, 'report');
    await assert.rejects(f.invoke(), /presentation|digest|metadata|Ambiguous/);
    assert.equal(f.mutations.length, 0);
  }
});
test('missing and expired standalone views keep verified evidence with explicit missing links', async t => {
  const f = await harness(t); const bundle = f.bundle(); f.view(bundle, 'report').expired = true;
  const r = await f.invoke();
  assert.match(r.body, /report.html unavailable/);
  assert.ok(!r.body.includes('[report.html](')); assert.ok(!r.body.includes('[compare.html]('));
  assert.ok(r.body.includes(`[evidence.zip](https://github.com/owner/repo/actions/runs/101/artifacts/${bundle.id})`));
});
