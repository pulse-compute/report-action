import { requireThat, positiveInteger } from './contracts.mjs';

// All endpoints are repository-relative paths constructed by trusted code.
// No artifact-provided URLs, redirects or credentials become API destinations.
export function publisherClient(repository, token, request = fetch) {
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && token, 'Authenticated repository required');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  function url(path) {
    requireThat(typeof path === 'string' && (path === '' || path.startsWith('/')) && !/(^|\/)\.\.(?:\/|\?|$)/.test(path) && !/[\r\n#]/.test(path), 'Invalid API path');
    return base + path;
  }
  async function bytes(response, limit) {
    requireThat(response.ok, `GitHub request failed (${response.status})`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; requireThat(size <= limit, 'GitHub response exceeds bound'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  return {
    async json(path, { method = 'GET', body } = {}) {
      requireThat(['GET', 'POST', 'PATCH'].includes(method), 'Unsupported API method');
      return JSON.parse(await bytes(await request(url(path), { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) }), 8 * 1024 * 1024));
    },
    async archive(id) {
      positiveInteger(id);
      let r = await request(url(`/actions/artifacts/${id}/zip`), { headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const location = new URL(r.headers.get('location'));
        requireThat(location.protocol === 'https:' && !location.username && !location.password, 'Unsafe signed archive URL');
        r = await request(location.href, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      }
      return bytes(r, 128 * 1024 * 1024);
    },
  };
}
export async function paginate(api, path, key) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api.json(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const list = key ? result[key] : result;
    requireThat(Array.isArray(list) && list.length <= 100, 'Unexpected GitHub page');
    rows.push(...list); if (list.length < 100) return rows;
  }
  throw new Error('GitHub pagination exceeds bound');
}
