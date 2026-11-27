import {
  SHORT_TERM_12_REGIONS,
  buildShortTerm12Payload,
  summarizeHourlyWindow,
  alignShortTermSnapshotToNow,
  kst
} from './bionda-core.js';
import { loadPointForecast, insertGayaRow } from '../public/hourly-point.js';

const PAGES_HOURLY_FRESH_URL = 'https://bionda-edge-cache.internal/__pages_hourly_v2/fresh/r13';
const PAGES_HOURLY_LAST_GOOD_URL = 'https://bionda-edge-cache.internal/__pages_hourly_v2/last-good/r13';
const LAST_GOOD_TTL_SEC = 12 * 3600;
let pagesRevalidateUntil = 0;

export function __resetPagesHourlyState() {
  pagesRevalidateUntil = 0;
}

function computeFreshHourlyTtlSec(nowMs = Date.now(), isPending = false) {
  const kstMin = kst(nowMs).getUTCMinutes();
  const secsToHour = Math.max(5, Math.ceil((3600000 - (nowMs % 3600000)) / 1000));
  const secsTo35 = kstMin < 35 ? (35 - kstMin) * 60 : 3600;
  const cap = isPending ? 45 : 240;
  return Math.max(10, Math.min(cap, secsToHour, secsTo35));
}

async function storeVerifiedPagesHourly(edgeCache, context, data, nowMs = Date.now()) {
  if (!edgeCache || !data?.ok || !Array.isArray(data.regions)) return;
  const completeRegions = data.regions.filter(r => Array.isArray(r.hours) && r.hours.length > 0).length;
  if (completeRegions < 13) return;

  const isMixed = Boolean(data.sources?.mixedGeneration);
  const cleanPayload = {
    ...data,
    sources: {
      ...(data.sources || {}),
      servedFromLastGood: false,
      revalidating: false
    }
  };
  const body = JSON.stringify(cleanPayload);
  const freshTtl = computeFreshHourlyTtlSec(nowMs, Boolean(data.sources?.isFallback || isMixed));

  const freshRes = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${isMixed ? 30 : 60}, s-maxage=${freshTtl}, stale-while-revalidate=60`,
      'Access-Control-Allow-Origin': '*'
    }
  });
  const lastGoodRes = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${LAST_GOOD_TTL_SEC}, s-maxage=${LAST_GOOD_TTL_SEC}`,
      'Access-Control-Allow-Origin': '*'
    }
  });

  const writes = Promise.allSettled([
    edgeCache.put(new Request(PAGES_HOURLY_FRESH_URL), freshRes),
    edgeCache.put(new Request(PAGES_HOURLY_LAST_GOOD_URL), lastGoodRes)
  ]);
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(writes);
  } else {
    await writes;
  }
}

export async function servePagesShortTerm12(context, loadFresh) {
  const request = context.request;
  const url = new URL(request.url);
  const isForced = url.searchParams.get('force') === '1' || url.searchParams.get('hard') === '1' || url.searchParams.get('refresh') === '1';
  const isBypass = isForced || url.searchParams.get('refreshShort') === '1' || url.searchParams.get('refreshUltra') === '1';
  const isRevalidate = url.searchParams.get('revalidate') === '1';
  const ua = request.headers.get('user-agent') || '';
  const isArchivalBot = /Bionda-(Night-Weather|Briefing)/i.test(ua);
  const edgeCache = globalThis.caches?.default || null;

  if (!edgeCache) {
    return loadFresh(request);
  }

  // 1) 유효 시간(:00 / :35 경계 내) Fresh Edge Cache 적중 시 즉시 반환 (~15ms)
  if (!isBypass && !isRevalidate) {
    try {
      const freshHit = await edgeCache.match(new Request(PAGES_HOURLY_FRESH_URL));
      if (freshHit) {
        const headers = new Headers(freshHit.headers);
        headers.set('X-Bionda-Cache', 'HIT-FRESH');
        return new Response(request.method === 'HEAD' ? null : freshHit.body, {
          status: freshHit.status,
          headers
        });
      }
    } catch {}
  }

  // 2) Fresh 만료 시: 직전 성공한 공유 스냅샷(Last-Good)을 현재 시각으로 정렬해 즉시 반환하고 백그라운드 갱신
  if (!isBypass && !isRevalidate && !isArchivalBot) {
    try {
      const lastGoodHit = await edgeCache.match(new Request(PAGES_HOURLY_LAST_GOOD_URL));
      if (lastGoodHit) {
        const snap = await lastGoodHit.json();
        const nowMs = Date.now();
        const aligned = alignShortTermSnapshotToNow(snap, nowMs, { maxAgeMs: LAST_GOOD_TTL_SEC * 1000 });
        if (aligned) {
          if (typeof context.waitUntil === 'function' && nowMs >= pagesRevalidateUntil) {
            pagesRevalidateUntil = nowMs + 25000;
            const bgUrl = new URL(request.url);
            bgUrl.searchParams.set('roster', '13');
            bgUrl.searchParams.set('revalidate', '1');
            const bgReq = new Request(bgUrl.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
            context.waitUntil((async () => {
              try {
                const bgRes = await loadFresh(bgReq);
                if (bgRes.ok) {
                  const bgData = await bgRes.clone().json();
                  await storeVerifiedPagesHourly(edgeCache, null, bgData, Date.now());
                }
              } catch {} finally {
                pagesRevalidateUntil = 0;
              }
            })());
          }
          return new Response(request.method === 'HEAD' ? null : JSON.stringify(aligned), {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'public, max-age=5, s-maxage=15',
              'X-Bionda-Cache': 'HIT-LAST-GOOD-SWR',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }
    } catch {}
  }

  // 3) 최초 콜드 시드 / 백그라운드 revalidate=1 / 수동 강제 갱신 시 원천 조회 후 Fresh + Last-Good 동시 갱신
  const response = await loadFresh(request);
  if (response.ok) {
    try {
      const freshData = await response.clone().json();
      await storeVerifiedPagesHourly(edgeCache, context, freshData, Date.now());
    } catch {}
    const outHeaders = new Headers(response.headers);
    outHeaders.set('X-Bionda-Cache', isRevalidate ? 'REVALIDATED' : (isBypass ? 'BYPASS' : 'MISS-SEED'));
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers: outHeaders
    });
  }

  // 상류 일시 502 장애 시에도 비강제 요청은 Last-Good 스냅샷으로 무중단 복구
  if (!isForced) {
    try {
      const fallbackHit = await edgeCache.match(new Request(PAGES_HOURLY_LAST_GOOD_URL));
      if (fallbackHit) {
        const snap = await fallbackHit.json();
        const aligned = alignShortTermSnapshotToNow(snap, Date.now(), { maxAgeMs: LAST_GOOD_TTL_SEC * 1000 });
        if (aligned) {
          return new Response(request.method === 'HEAD' ? null : JSON.stringify(aligned), {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Bionda-Cache': 'FALLBACK-LAST-GOOD',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }
    } catch {}
  }

  return response;
}

export async function completeBoundHourlyResponse(response, request, service) {
  if (!response.ok) return response;
  const batch = await response.clone().json();
  if (!batch.ok || !Array.isArray(batch.regions) || batch.regions.some(r => r.id === 'gaya')) return response;
  const url = new URL(request.url);
  const isForced = url.searchParams.get('force') === '1' || url.searchParams.get('hard') === '1';
  const point = await loadPointForecast(SHORT_TERM_12_REGIONS.find(r => r.id === 'gaya'),
    new URL('/api/forecast', url), target => service.fetch(new Request(target, { headers: request.headers })),
    isForced);
  const regions = insertGayaRow(batch, SHORT_TERM_12_REGIONS, point, summarizeHourlyWindow);
  const result = buildShortTerm12Payload({ now: Date.parse(batch.updatedAt), regionResults: regions });
  const headers = new Headers(response.headers);
  for (const key of ['content-length', 'content-encoding', 'etag']) headers.delete(key);
  headers.set('Cache-Control', isForced ? 'no-store' : 'public, max-age=60, s-maxage=180, stale-while-revalidate=60');
  return new Response(JSON.stringify({ ...batch, ...result }), { headers });
}
