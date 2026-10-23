import { requireThat, revision } from './contracts.mjs';

export function documentationLink({ repository, sha, status = 'version status unavailable' }) {
  requireThat(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid documentation repository');
  revision(sha);
  return `Documentation and troubleshooting: [report-action](https://github.com/${repository}/tree/${sha}) — ${status}.`;
}

// Optional public metadata only. Never send a consumer token or use response
// URLs/content as Markdown. A failed freshness lookup cannot block reports.
export async function documentationFooter({ repository, sha, request = fetch }) {
  const fallback = documentationLink({ repository, sha });
  try {
    const response = await request(`https://api.github.com/repos/${repository}/compare/${sha}...main?per_page=1`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return fallback;
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; requireThat(bytes <= 1024 * 1024, 'Version metadata exceeds bound'); chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks));
    const count = n => Number.isSafeInteger(n) && n >= 0;
    let status;
    if (data.status === 'identical' && data.ahead_by === 0 && data.behind_by === 0) status = 'up to date with main';
    else if (data.status === 'ahead' && count(data.ahead_by) && data.ahead_by > 0 && data.behind_by === 0)
      status = `${data.ahead_by} commit${data.ahead_by === 1 ? '' : 's'} behind main`;
    else if (data.status === 'behind' && count(data.behind_by) && data.behind_by > 0 && data.ahead_by === 0)
      status = `${data.behind_by} commit${data.behind_by === 1 ? '' : 's'} ahead of main`;
    else if (data.status === 'diverged' && count(data.ahead_by) && count(data.behind_by) && data.ahead_by > 0 && data.behind_by > 0)
      status = 'diverged from main';
    return status ? documentationLink({ repository, sha, status }) : fallback;
  } catch { return fallback; }
}
