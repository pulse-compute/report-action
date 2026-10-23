import test from 'node:test';
import assert from 'node:assert/strict';
import { documentationLink, documentationFooter } from '../src/documentation.mjs';

const pin = { repository: 'pulse-compute/report-action', sha: 'a'.repeat(40) };
test('documentation links use the exact pin and report the comparison direction correctly', async () => {
  for (const [data, expected] of [
    [{ status: 'ahead', ahead_by: 3, behind_by: 0 }, '3 commits behind main'],
    [{ status: 'ahead', ahead_by: 1, behind_by: 0 }, '1 commit behind main'],
    [{ status: 'identical', ahead_by: 0, behind_by: 0 }, 'up to date with main'],
    [{ status: 'behind', ahead_by: 0, behind_by: 2 }, '2 commits ahead of main'],
    [{ status: 'diverged', ahead_by: 3, behind_by: 2 }, 'diverged from main'],
  ]) {
    const text = await documentationFooter({ ...pin, request: async (url, options) => {
      assert.equal(url, `https://api.github.com/repos/${pin.repository}/compare/${pin.sha}...main?per_page=1`);
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
      return Response.json({ ...data, html_url: 'https://attacker.invalid', message: '[untrusted]' });
    } });
    assert.equal(text, `Documentation and troubleshooting: [report-action](https://github.com/${pin.repository}/tree/${pin.sha}) — ${expected}.`);
  }
});
test('unavailable, oversized and malformed version metadata retain the pinned link without blocking publication', async () => {
  for (const request of [
    async () => { throw new Error('network timeout'); },
    async () => new Response('', { status: 403 }),
    async () => new Response('', { status: 404 }),
    async () => new Response('bad JSON'),
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
    async () => Response.json({ status: 'ahead', ahead_by: -1, behind_by: 0 }),
    async () => Response.json({ status: 'identical', ahead_by: 10, behind_by: 0 }),
    async () => Response.json({ status: 'ahead', ahead_by: '[bad](https://attacker.invalid)', behind_by: 0 }),
  ]) assert.equal(await documentationFooter({ ...pin, request }), documentationLink(pin));
  for (const bad of [{ ...pin, sha: 'main' }, { ...pin, repository: 'owner/repo](https://attacker.invalid)' }]) {
    await assert.rejects(documentationFooter({ ...bad, request: () => assert.fail('must reject before network') }));
  }
});
