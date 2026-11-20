import { servePagesCctv } from '../../lib/cctv-pages.mjs';
import { getServiceKey } from '../../lib/bionda-core.js';
import { completeBoundHourlyResponse } from '../../lib/hourly-roster.mjs';
import worker from '../../cloudflare/worker.js';

/**
 * Cloudflare Pages Functions (/api/*) 게이트웨이
 * - Service Binding(env.API_WORKER)이 연결되어 있으면 기존 bionda Worker(시크릿 보유)로 직접 0ms RPC 전달
 * - Pages 단독 환경변수만 설정된 경우 동일한 worker 모듈을 직접 실행
 */
export async function onRequest(context) {
  const method = String(context.request?.method || 'GET').toUpperCase();
  if ((method === 'GET' || method === 'HEAD') && typeof context.next === 'function') {
    try {
      const { pathname } = new URL(context.request.url);
      if (/\.(?:json|png|jpe?g|webp|svg|txt)$/i.test(pathname)) {
        return context.next();
      }
    } catch {}
  }
  if (method === 'GET' && new URL(context.request.url).pathname === '/api/cctv') {
    return servePagesCctv(context);
  }
  if (context.env?.API_WORKER && typeof context.env.API_WORKER.fetch === 'function') {
    const service = context.env.API_WORKER;
    if (method === 'GET' && new URL(context.request.url).pathname === '/api/short-term-12') {
      if (getServiceKey(context.env)) {
        const local = await worker.fetch(context.request, context.env, { waitUntil: p => context.waitUntil(p) });
        if (local.ok) return completeBoundHourlyResponse(local, context.request, service);
      }
      return completeBoundHourlyResponse(await service.fetch(context.request), context.request, service);
    }
    return service.fetch(context.request);
  }
  return worker.fetch(context.request, context.env, {
    waitUntil: p => context.waitUntil(p)
  });
}
