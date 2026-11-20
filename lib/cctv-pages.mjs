import worker, { buildCorsHeaders } from '../cloudflare/worker.js';
import { isCctvConfigured } from './cctv-its.js';

// Some ITS playback URLs expire. Never extend this limit on cache hits.
const LAST_GOOD_SECONDS = 30 * 60;

export async function servePagesCctv(context) {
  const { request, env } = context;
  const local = () => worker.fetch(request, env, context);
  const bound = env.API_WORKER;
  let response;
  if (bound) {
    try {
      response = await bound.fetch(request);
    } catch {
      response = Response.json({ ok: false, error: 'CCTV_SERVICE_UNAVAILABLE' }, {
        status: 502, headers: buildCorsHeaders(request, env),
      });
    }
    if ((response.status >= 500 || response.status === 404) && isCctvConfigured(env)) {
      response = await local();
    }
  } else {
    response = await local();
  }
  const cache = globalThis.caches?.default;
  if (!cache) return response;
  const key = new Request(new URL('/__bionda_cache/cctv-last-good', request.url));
  if (response.ok) {
    // Store only the normalised list, without per-request CORS headers.
    const copy = response.clone();
    context.waitUntil((async () => {
      const payload = await copy.json();
      const age = (Date.now() - Date.parse(payload.fetchedAt)) / 1000;
      const remaining = Math.floor(LAST_GOOD_SECONDS - age);
      if (payload.ok && payload.cctvs?.length && age >= 0 && remaining > 0) {
        await cache.put(key, Response.json(payload, { headers: { 'Cache-Control': 'public, max-age=' + remaining } }));
      }
    })().catch(() => {}));
  } else if (response.status >= 500) {
    try {
      const cached = await cache.match(key);
      if (cached) {
        const payload = await cached.json();
        const age = Date.now() - Date.parse(payload.fetchedAt);
        if (age >= 0 && age < LAST_GOOD_SECONDS * 1000 && payload.cctvs?.length) {
          const headers = buildCorsHeaders(request, env);
          headers.set('X-Cache', 'STALE');
          headers.set('Cache-Control', 'no-store');
          return Response.json({ ...payload, cache: 'STALE' }, { headers });
        }
      }
    } catch { /* Return the upstream error when the cache is unavailable. */ }
  }
  return response;
}
