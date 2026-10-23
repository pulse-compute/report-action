// Run only after the hosted reusable capture workflow; no project code or HTML
// is evaluated. This qualifies GitHub's actual unarchived artifact response.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publisherClient, paginate } from '../src/github.mjs';
import { evidenceReader } from '../src/publisher-artifacts.mjs';
import { verifyBundle } from '../src/evidence.mjs';
import { presentationName } from '../src/presentation.mjs';
import { projectLabel } from '../src/contracts.mjs';
const e = process.env, api = publisherClient(e.GITHUB_REPOSITORY, e.GH_TOKEN);
const run = await api.json(`/actions/runs/${Number(e.GITHUB_RUN_ID)}`);
const artifacts = await paginate(api, `/actions/runs/${run.id}/artifacts`, 'artifacts');
const stage = mkdtempSync(join(tmpdir(), 'hosted-presentations-'));
try {
  const read = evidenceReader({ api, stage }); let count = 0;
  for (const artifact of artifacts.filter(a => /^pulse-report-/.test(a.name) && !/-binding$|\.html$/.test(a.name))) {
    const bundle = await read(artifact, run);
    assert.ok(bundle && bundle.capture.status === 'captured');
    const manifest = verifyBundle(bundle.root, JSON.parse(readFileSync(join(bundle.root, 'manifest.json'))));
    const capsule = JSON.parse(readFileSync(join(bundle.root, 'head.json')));
    assert.equal(capsule.application.name, projectLabel(manifest.project.root, e.GITHUB_REPOSITORY));
    const role = bundle.capture.comparison ? 'compare' : 'report';
    const file = manifest.files.find(f => f.role === (role === 'report' ? 'head-html' : 'compare-html'));
    if (!file) continue;
    const views = artifacts.filter(a => a.name === presentationName(artifact.name, role));
    assert.equal(views.length, 1);
    assert.ok(await read.view(views[0], run, file)); count++;
  }
  assert.ok(count >= 2, 'Expected actual unarchived report and comparison downloads');
  console.log(`Verified ${count} standalone HTML artifacts against complete evidence bundles.`);
} finally { rmSync(stage, { recursive: true, force: true }); }
