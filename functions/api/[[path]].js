import worker from '../../cloudflare/worker.js';

/**
 * Cloudflare Pages Functions (/api/*) 게이트웨이
 * - Service Binding(env.API_WORKER)이 연결되어 있으면 기존 bionda Worker(시크릿 보유)로 직접 0ms RPC 전달
 * - Pages 단독 환경변수만 설정된 경우 동일한 worker 모듈을 직접 실행
 */
export async function onRequest(context) {
  if (context.env?.API_WORKER && typeof context.env.API_WORKER.fetch === 'function') {
    return context.env.API_WORKER.fetch(context.request);
  }
  return worker.fetch(context.request, context.env, {
    waitUntil: p => context.waitUntil(p)
  });
}
