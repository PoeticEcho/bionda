/**
 * 비온다? × 날씨봇 — Cloudflare Workers 무료 티어(24시간 무슬립·일 10만 요청) API 프록시
 * - 비밀 인증키(KMA_SERVICE_KEY 등)는 Cloudflare Workers Secrets(환경변수)에만 보관합니다.
 * - GitHub Pages(poeticecho.github.io) 프론트엔드에서 CORS로 직접 호출해 5분 실시간 갱신을 수행합니다.
 */
import {
  DATA_GO_KR_BASE,
  APIHUB_FCST_BASE,
  getServiceKey,
  getRadarKey,
  getRoadKey,
  getRoadLineCode,
  kst,
  datePart,
  timePart,
  isoKst,
  deEncodedKey,
  errMessage,
  baseUltra,
  baseShort,
  baseObservation,
  latlonToGrid,
  buildForecastResult,
  parseKmaForecastJson,
  parseRoadStations,
  matchRoadStation,
  parseNcstValues,
  mergeObservationResult,
  parseWrnNow,
  sortWarnings,
  extractCapLinksFromRss,
  populateCapPolygons,
  warningMatchesPlace,
  detectRadarImageType,
  utcFiveMinSlot,
  extractZipTextEntries,
  parseZipEntryTimestamp,
  parseRoadRiskCsv,
  buildRoadRiskPayload,
  matchStationRiskForCoord,
  collectShortTerm12,
  parseOverviewPlacesParam,
  canonicalOverviewPlacesKey,
  buildRoadTrendSlots,
  assembleRoadTrendPayload,
  CORRIDOR_WATCHED_PLACES,
  resolveBriefingEditionMeta,
  buildRoadHistoryWindowSlots,
  assembleRoadHistoryChunk
} from '../lib/bionda-core.js';
import {
  CCTV_CACHE_TTL_SECONDS,
  buildCctvPayload,
  isCctvConfigured
} from '../lib/cctv-its.js';
import { handleRwisFetch } from './rwis-worker.js';

/**
 * /rwis 프리픽스 — 광주대구선 RWIS·CCTV 대시보드 API (cloudflare/rwis-worker.js)
 *   /rwis              → rwis-worker 의 /
 *   /rwis/api/status   → rwis-worker 의 /api/status  (기존 bionda /api/* 와 충돌 없음)
 *
 * /api/rwis 도 같은 대상으로 위임합니다. (회사 PC 방화벽이 *.workers.dev 를 막는 환경에서
 * 이미 Service Binding 으로 연결된 Pages 게이트웨이 bionda.pages.dev/api/* 를 통과시키기 위함)
 *   /api/rwis              → /
 *   /api/rwis/api/status   → /api/status
 *   /api/rwis/api/cctv     → /api/cctv   (Pages functions 의 `/api/cctv` 정확 일치에도 걸리지 않음)
 */
const RWIS_PREFIXES = ['/api/rwis', '/rwis'];

function matchRwisPrefix(pathname) {
  return RWIS_PREFIXES.find(p => pathname === p || pathname.startsWith(`${p}/`)) || null;
}

function rewriteRwisRequest(request, url, prefix) {
  const stripped = url.pathname.slice(prefix.length) || '/';
  const target = new URL(url.toString());
  target.pathname = stripped.startsWith('/') ? stripped : `/${stripped}`;
  return new Request(target.toString(), request);
}

const SHARED_CACHE = new Map();
const INFLIGHT = new Map();
const REQUESTS = new Map();

function getCached(key) {
  const item = SHARED_CACHE.get(key);
  return item && item.expires > Date.now() ? item.value : null;
}

function setCached(key, value, ms) {
  if (SHARED_CACHE.size > 400) {
    for (const [k, v] of SHARED_CACHE) if (v.expires <= Date.now()) SHARED_CACHE.delete(k);
    if (SHARED_CACHE.size > 400) SHARED_CACHE.delete(SHARED_CACHE.keys().next().value);
  }
  SHARED_CACHE.set(key, { value, expires: Date.now() + ms });
}

/**
 * Cloudflare Workers(workerd, compatibility_date >= 2025)에서는 종료된 요청(Ended Request)이 만든
 * Promise를 다른 요청에서 await 하면 "This promise was created by a request that has since ended,
 * so it can never settle" 예외와 함께 해당 isolate가 영구 502 교착에 빠집니다.
 * 따라서 요청 간 캐싱은 순수 결과값(SHARED_CACHE) 및 Edge Cache(caches.default)만 사용하고,
 * 미결 Promise 인스턴스는 절대 요청 간에 공유하지 않습니다.
 */
function withInFlight(_key, loader) {
  return Promise.resolve().then(loader);
}

function allow(ip) {
  const now = Date.now();
  const hit = REQUESTS.get(ip) || { t: now, n: 0 };
  if (now - hit.t > 60000) { hit.n = 0; hit.t = now; }
  hit.n++;
  REQUESTS.set(ip, hit);
  if (REQUESTS.size > 5000) REQUESTS.clear();
  return hit.n <= 240;
}

export function buildCorsHeaders(request, env = {}) {
  const headers = new Headers();
  const allowList = String(env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const reqOrigin = request.headers.get('Origin');
  if (!allowList.length) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && allowList.includes(reqOrigin)) {
    headers.set('Access-Control-Allow-Origin', reqOrigin);
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '600');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer-when-downgrade');
  return headers;
}

function jsonResponse(request, env, status, payload, extraHeaders = {}) {
  const headers = buildCorsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(payload), { status, headers });
}

function edgeCacheRequest(urlObj, stripT = false) {
  const u = new URL('https://bionda-edge-cache.internal' + urlObj.pathname + urlObj.search);
  if (stripT) u.searchParams.delete('t');
  if ((urlObj.pathname === '/api/overview-bundle' || urlObj.pathname === '/api/warnings') && u.searchParams.has('places')) {
    const rawPlaces = u.searchParams.get('places') || '';
    const canon = canonicalOverviewPlacesKey(parseOverviewPlacesParam(rawPlaces));
    if (canon) u.searchParams.set('places', canon);
  }
  return new Request(u.toString(), { method: 'GET' });
}

async function matchEdgeCache(request, env, cacheKeyReq) {
  try {
    const cache = globalThis.caches?.default;
    if (!cache) return null;
    const hit = await cache.match(cacheKeyReq);
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    const cors = buildCorsHeaders(request, env);
    cors.forEach((v, k) => headers.set(k, v));
    return new Response(request.method === 'HEAD' ? null : hit.body, { status: hit.status, headers });
  } catch {
    return null;
  }
}

function putEdgeCache(ctx, cacheKeyReq, response) {
  try {
    const cache = globalThis.caches?.default;
    if (!cache || response.status !== 200) return;
    const promise = cache.put(cacheKeyReq, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(promise.catch(() => {}));
    }
  } catch {}
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
  return fetch(url, signal ? { ...options, signal } : options);
}

async function fetchKmaFromBase(baseUrl, resource, grid, base, rawKey, timeout = 7500) {
  const u = new URL(baseUrl + resource);
  const cleanKey = deEncodedKey(rawKey);
  u.searchParams.set('serviceKey', cleanKey);
  if (baseUrl.includes('apihub.kma.go.kr')) {
    u.searchParams.set('authKey', cleanKey);
  }
  u.searchParams.set('numOfRows', resource === 'getVilageFcst' ? '1000' : '800');
  u.searchParams.set('pageNo', '1');
  u.searchParams.set('dataType', 'JSON');
  u.searchParams.set('base_date', datePart(base));
  u.searchParams.set('base_time', timePart(base));
  u.searchParams.set('nx', String(grid.nx));
  u.searchParams.set('ny', String(grid.ny));
  const r = await fetchWithTimeout(u.toString(), { headers: { Accept: 'application/json' } }, timeout);
  if (!r.ok) {
    const err = new Error(`기상청 응답 오류 HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return parseKmaForecastJson(await r.text());
}

async function fetchKma(env, resource, grid, base, timeout = 5000, bypassCache = false) {
  const apiKey = getServiceKey(env);
  if (!apiKey) throw new Error('KMA_SERVICE_KEY 미설정');
  const cacheKey = `kma|${resource}|${grid.nx}|${grid.ny}|${datePart(base)}|${timePart(base)}`;
  const staleKey = `kma-stale|${resource}|${grid.nx}|${grid.ny}`;
  const hit = !bypassCache ? getCached(cacheKey) : null;
  if (hit) return hit;

  return withInFlight(bypassCache ? `${cacheKey}|bypass` : cacheKey, async () => {
    const isApiHubKey = /^[A-Za-z0-9_-]{20,26}$/.test(apiKey.trim()) && !apiKey.includes('dummy');
    const skipDataGoKr = isApiHubKey && Boolean(getCached('skip-host|data.go.kr'));
    const bases = isApiHubKey
      ? (skipDataGoKr ? [APIHUB_FCST_BASE] : [APIHUB_FCST_BASE, DATA_GO_KR_BASE])
      : [DATA_GO_KR_BASE, APIHUB_FCST_BASE];

    let lastErr;
    for (let i = 0; i < bases.length; i++) {
      const baseUrl = bases[i];
      if (isApiHubKey && baseUrl.includes('data.go.kr') && getCached('skip-host|data.go.kr')) {
        continue;
      }
      const attemptTimeout = i > 0 ? Math.min(timeout, 3500) : timeout;
      try {
        const items = await fetchKmaFromBase(baseUrl, resource, grid, base, apiKey, attemptTimeout);
        const ttlMs = resource === 'getVilageFcst' ? 45 * 60000 : 5 * 60000;
        const staleTtlMs = resource === 'getVilageFcst' ? 6 * 3600000 : 90 * 60000;
        setCached(cacheKey, items, ttlMs);
        // 단조 증가(Monotonic) Stale 보호: 과거 발표회차 폴백 조회가 이미 보관된 최신 발표회차를 덮어쓰지 못하도록 차단
        const nextIso = isoKst(base);
        const prevStale = getCached(staleKey);
        if (!prevStale?.base || Date.parse(nextIso) >= Date.parse(prevStale.base)) {
          setCached(staleKey, { items, base: nextIso }, staleTtlMs);
        }
        return items;
      } catch (e) {
        lastErr = e;
        const hostTag = baseUrl.includes('apihub') ? 'apihub' : 'data.go.kr';
        if (isApiHubKey && hostTag === 'data.go.kr' && (e?.status === 401 || e?.status === 403 || /HTTP 40[13]/.test(errMessage(e)))) {
          setCached('skip-host|data.go.kr', true, 60 * 60000);
        }
        console.warn('[fetchKma]', resource, hostTag, grid.nx, grid.ny, errMessage(e));
      }
    }
    throw lastErr;
  });
}

async function fetchWithFallback(env, resource, grid, base, prevMinutes, bypassCache = false) {
  try {
    return { items: await fetchKma(env, resource, grid, base, 5000, bypassCache), base: isoKst(base) };
  } catch (error) {
    const previous = new Date(base.getTime() - prevMinutes * 60000);
    // 이미 직전 정상 수신본(stale)의 발표시각이 previous보다 최신(예: 17:00 보유 중 일시 타임아웃 시 14:00 역행 방지)이면 stale 우선 반환!
    const staleFirst = getCached(`kma-stale|${resource}|${grid.nx}|${grid.ny}`);
    if (staleFirst?.items?.length && staleFirst.base && Date.parse(staleFirst.base) > Date.parse(isoKst(previous))) {
      return {
        items: staleFirst.items,
        base: staleFirst.base,
        notice: '기상청 일시 지연으로 직전 수신 최신회차 유지',
        stale: true
      };
    }
    try {
      return {
        items: await fetchKma(env, resource, grid, previous, 5000, bypassCache),
        base: isoKst(previous),
        notice: '최신 발표분을 가져오지 못해 직전 발표분 사용'
      };
    } catch {
      const stale = getCached(`kma-stale|${resource}|${grid.nx}|${grid.ny}`);
      if (stale?.items?.length) {
        return {
          items: stale.items,
          base: stale.base,
          notice: '기상청 일시 지연으로 직전 수신 자료 사용',
          stale: true
        };
      }
      throw error;
    }
  }
}

async function forecast(env, lat, lon, bypassCache = false) {
  const grid = latlonToGrid(lat, lon);
  if (grid.nx < 1 || grid.nx > 149 || grid.ny < 1 || grid.ny > 253) {
    throw new Error('기상청 예보격자 범위를 벗어난 좌표입니다.');
  }
  const now = Date.now();
  const requests = await Promise.allSettled([
    fetchWithFallback(env, 'getUltraSrtFcst', grid, baseUltra(now), 60, bypassCache),
    fetchWithFallback(env, 'getVilageFcst', grid, baseShort(now), 180, bypassCache),
    fetchWithFallback(env, 'getUltraSrtNcst', grid, baseObservation(now), 60, bypassCache)
  ]);
  return buildForecastResult(grid, now, requests);
}

async function fetchShortTerm12(env, optionsOrForce = false) {
  const apiKey = getServiceKey(env);
  if (!apiKey) throw new Error('KMA_SERVICE_KEY 미설정');
  const opts = typeof optionsOrForce === 'object' && optionsOrForce !== null
    ? optionsOrForce
    : { force: Boolean(optionsOrForce) };
  const force = Boolean(opts.force);
  const refreshShort = opts.refreshShort !== undefined ? Boolean(opts.refreshShort) : force;
  const refreshUltra = opts.refreshUltra !== undefined ? Boolean(opts.refreshUltra) : force;
  const bypassTop = force || refreshShort || refreshUltra;

  const now = Date.now();
  const sBase = baseShort(now);
  const uBase = baseUltra(now);
  const curHour = timePart(kst(now)).slice(0, 2);
  const cacheKey = `short12|${datePart(sBase)}|${timePart(sBase)}|${timePart(uBase)}|h${curHour}`;
  const hit = !bypassTop ? getCached(cacheKey) : null;
  if (hit) return hit;

  return withInFlight(bypassTop ? `${cacheKey}|force` : cacheKey, async () => {
    let resolvedUBase = null;
    let probePromise = null;
    const fetchUltraSmart = async (grid) => {
      if (!resolvedUBase) {
        if (!probePromise) {
          probePromise = fetchWithFallback(env, 'getUltraSrtFcst', grid, uBase, 60, refreshUltra)
            .then(res => {
              resolvedUBase = res.base === isoKst(uBase) ? uBase : new Date(uBase.getTime() - 60 * 60000);
              return { firstKey: `${grid.nx},${grid.ny}`, res };
            })
            .catch(err => {
              probePromise = null;
              throw err;
            });
        }
        const probed = await probePromise;
        if (probed.firstKey === `${grid.nx},${grid.ny}`) return probed.res;
      }
      const activeBase = resolvedUBase || uBase;
      return { items: await fetchKma(env, 'getUltraSrtFcst', grid, activeBase, 6000, refreshUltra), base: isoKst(activeBase) };
    };

    let payload = await collectShortTerm12({
      now,
      fetchShort: (grid) => fetchWithFallback(env, 'getVilageFcst', grid, sBase, 180, refreshShort),
      fetchUltra: fetchUltraSmart
    });
    const verifiedKey = `short12-last-verified|h${curHour}`;
    const lastVerified = getCached(verifiedKey);
    const curShortMs = Date.parse(payload.sources?.shortBase || '');
    const prevShortMs = Date.parse(lastVerified?.sources?.shortBase || '');
    // 회차 역행 원천 차단: 이미 검증 게시된 최신 발표회차보다 오래된 회차로 후퇴하려 할 경우 직전 검증 배치를 유지
    if (!opts.hard && lastVerified && Number.isFinite(prevShortMs) && (!Number.isFinite(curShortMs) || curShortMs < prevShortMs)) {
      payload = {
        ...lastVerified,
        sources: {
          ...lastVerified.sources,
          isFallback: true,
          status: 'stale-preserved',
          fallbackReason: '상류 지연으로 직전 검증 최신회차 유지'
        }
      };
    }

    const completeRegions = (payload.regions || []).filter(r => Array.isArray(r.hours) && r.hours.length > 0).length;
    const isMixed = Boolean(payload.sources?.mixedGeneration);
    if (completeRegions >= 13 && !isMixed && payload.sources?.shortBase) {
      setCached(verifiedKey, payload, 3 * 3600000);
    }
    const pendingShort = !payload.sources?.shortBase || Date.parse(payload.sources.shortBase) < Date.parse(isoKst(sBase));
    const pendingUltra = !resolvedUBase || resolvedUBase.getTime() < uBase.getTime();
    const ttlMs = (completeRegions < 13 || isMixed) ? 20000 : ((pendingShort || pendingUltra) ? 45000 : 5 * 60000);
    setCached(cacheKey, payload, ttlMs);
    return payload;
  });
}

async function fetchRoadStations(env, line = getRoadLineCode(env), bypassCache = false, ctx = null) {
  const key = getRoadKey(env);
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const cacheKey = `road-obs|${line}`;
  const staleKey = `road-obs-last-good|${line}`;
  const edgeLastGoodReq = new Request(`https://bionda-edge-cache.internal/__last_good/road-obs/${encodeURIComponent(line)}`);
  const edgeRoadObsReq = edgeCacheRequest(new URL(`https://bionda-edge-cache.internal/api/road-obs?line=${encodeURIComponent(line)}`), false);
  const hit = !bypassCache ? getCached(cacheKey) : null;
  if (hit) return hit;

  return withInFlight(bypassCache ? `${cacheKey}|bypass` : cacheKey, async () => {
    const now = Date.now();
    // 1분 단위 KMA 도로기상관측 실시간 동기화 (1분 전부터 순차 탐색해 rwis.kma.go.kr와 1~2분 내 정합성 유지)
    const offsetsMinutes = [1, 2, 3, 5, 8];
    let lastStations = [];
    let lastTm1 = '';
    for (const off of offsetsMinutes) {
      try {
        const d = kst(now - off * 60000);
        const tm1 = datePart(d) + timePart(d);
        const u = new URL('https://apihub.kma.go.kr/api/typ01/url/road_stn_obs.php');
        u.searchParams.set('mode', '2');
        u.searchParams.set('tm1', tm1);
        u.searchParams.set('var', String(line));
        u.searchParams.set('disp', '1');
        u.searchParams.set('help', '2');
        u.searchParams.set('authKey', deEncodedKey(key));
        const r = await fetchWithTimeout(u.toString(), {}, 6500);
        if (!r.ok) {
          console.warn('[fetchRoadStations] HTTP', r.status, tm1);
          continue;
        }
        const bytes = new Uint8Array(await r.arrayBuffer());
        const text = new TextDecoder('euc-kr').decode(bytes);
        const parsed = parseRoadStations(text);
        if (parsed.length) {
          lastStations = parsed;
          lastTm1 = tm1;
          if (parsed.some(s => s.temp !== null || s.roadTemp !== null)) {
            const result = { ok: true, line: String(line), tm1, updatedAt: new Date().toISOString(), stations: parsed };
            // 45초 단기 캐시로 도로기상상황판(index)과 도로살얼음상황판(rwis) 모두 실시간 정합성 보장
            setCached(cacheKey, result, 45000);
            setCached(staleKey, result, 20 * 60000);
            const edgeCache = globalThis.caches?.default;
            if (edgeCache) {
              const bodyStr = JSON.stringify(result);
              putEdgeCache(ctx, edgeLastGoodReq, new Response(bodyStr, {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=900, s-maxage=900' }
              }));
              putEdgeCache(ctx, edgeRoadObsReq, new Response(bodyStr, {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30, s-maxage=45' }
              }));
            }
            return result;
          }
        }
      } catch (e) {
        console.warn('[fetchRoadStations] err off=' + off, errMessage(e));
      }
    }
    if (lastStations.length) {
      const result = { ok: true, line: String(line), tm1: lastTm1, updatedAt: new Date().toISOString(), stations: lastStations };
      setCached(cacheKey, result, 30000);
      return result;
    }
    const stale = getCached(staleKey);
    if (stale) return { ...stale, stale: true };
    // 콜드 워커 인스턴스 기동 직후 상류 일시 지연 시 Edge Last-Good 백업으로 502 방지
    try {
      const edgeCache = globalThis.caches?.default;
      if (edgeCache) {
        const edgeStale = await edgeCache.match(edgeLastGoodReq);
        if (edgeStale) {
          const parsedStale = await edgeStale.json();
          if (parsedStale?.stations?.length) {
            setCached(staleKey, parsedStale, 10 * 60000);
            return { ...parsedStale, stale: true };
          }
        }
      }
    } catch {}
    throw new Error('도로기상관측 자료를 가져오지 못했습니다.');
  });
}

async function fetchRoadStationsAtSlot(env, line, slot, bypassCache = false, ctx = null) {
  const key = getRoadKey(env);
  if (!key) return null;
  if (slot.isLatest && !bypassCache) {
    const liveHit = getCached(`road-obs|${line}`);
    if (liveHit?.stations?.length) return liveHit.stations;
  }
  const slotCacheKey = `road-slot|${line}|${slot.tm1}`;
  const edgeSlotReq = slot.immutable
    ? new Request(`https://bionda-edge-cache.internal/__road_slot/${encodeURIComponent(line)}/${encodeURIComponent(slot.tm1)}`)
    : null;
  if (!bypassCache) {
    const hit = getCached(slotCacheKey);
    if (hit) return hit;
    if (edgeSlotReq) {
      try {
        const edgeHit = await globalThis.caches?.default?.match(edgeSlotReq);
        if (edgeHit) {
          const parsedEdge = await edgeHit.json();
          if (Array.isArray(parsedEdge) && parsedEdge.length) {
            setCached(slotCacheKey, parsedEdge, 6 * 3600000);
            return parsedEdge;
          }
        }
      } catch {}
    }
  }
  try {
    const u = new URL('https://apihub.kma.go.kr/api/typ01/url/road_stn_obs.php');
    u.searchParams.set('mode', '2');
    u.searchParams.set('tm1', slot.tm1);
    u.searchParams.set('var', String(line));
    u.searchParams.set('disp', '1');
    u.searchParams.set('help', '2');
    u.searchParams.set('authKey', deEncodedKey(key));
    const r = await fetchWithTimeout(u.toString(), {}, 4200);
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const text = new TextDecoder('euc-kr').decode(bytes);
    const parsed = parseRoadStations(text);
    if (parsed.length && parsed.some(s => s.temp !== null || s.roadTemp !== null)) {
      setCached(slotCacheKey, parsed, slot.immutable ? 6 * 3600000 : 90000);
      if (edgeSlotReq) {
        putEdgeCache(ctx, edgeSlotReq, new Response(JSON.stringify(parsed), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600, s-maxage=21600' }
        }));
      }
      return parsed;
    }
  } catch (e) {
    console.warn('[fetchRoadStationsAtSlot] err tm1=' + slot.tm1, errMessage(e));
  }
  return null;
}

async function fetchRoadStationsTrend(env, line = getRoadLineCode(env), hours = 6, force = false, ctx = null) {
  const key = getRoadKey(env);
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const safeHours = Math.max(1, Math.min(12, Math.round(Number(hours) || 6)));
  const cacheKey = `road-obs-trend|${line}|${safeHours}`;
  const staleKey = `road-obs-trend-last-good|${line}|${safeHours}`;
  const hit = !force ? getCached(cacheKey) : null;
  if (hit) return hit;

  return withInFlight(force ? `${cacheKey}|force` : cacheKey, async () => {
    const nowMs = Date.now();
    const slots = buildRoadTrendSlots(nowMs, { hours: safeHours, stepMin: 30 });
    const slotResults = [];
    // Cloudflare Workers 동시 외부연결(6) 제한을 안전하게 지키기 위해 4개씩 분할 조회
    for (let i = 0; i < slots.length; i += 4) {
      const chunk = slots.slice(i, i + 4);
      const settled = await Promise.allSettled(
        chunk.map(async slot => ({
          slot,
          stations: await fetchRoadStationsAtSlot(env, line, slot, force && slot.isLatest, ctx)
        }))
      );
      for (const item of settled) {
        if (item.status === 'fulfilled' && item.value?.stations?.length) {
          slotResults.push(item.value);
        }
      }
    }
    const payload = assembleRoadTrendPayload({ line, hours: safeHours, stepMin: 30, slotResults, nowMs });
    if (payload.times.length > 0) {
      setCached(cacheKey, payload, 5 * 60000);
      setCached(staleKey, payload, 60 * 60000);
      return payload;
    }
    const stale = getCached(staleKey);
    if (stale) return stale;
    throw new Error('도로기상관측 6시간 추세 자료를 가져오지 못했습니다.');
  });
}

/**
 * STEP 5: 제설근무 매칭·CSV 추출용 도로기상관측 과거 구간 청크 조회 (수동 실행 전용 · 1회 최대 37슬롯)
 */
async function fetchRoadStationsHistoryChunk(env, { line = getRoadLineCode(env), endMs = Date.now(), hours = 12, stepMin = 30, force = false } = {}, ctx = null) {
  const key = getRoadKey(env);
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const nowMs = Date.now();
  const slots = buildRoadHistoryWindowSlots({ endMs, hours, stepMin, nowMs });
  const slotResults = [];
  for (let i = 0; i < slots.length; i += 5) {
    const batch = slots.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(async slot => ({
        slot,
        stations: await fetchRoadStationsAtSlot(env, line, slot, force && !slot.immutable, ctx)
      }))
    );
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value?.stations?.length) {
        slotResults.push(item.value);
      }
    }
  }
  return assembleRoadHistoryChunk({ line, hours, stepMin, slotResults, nowMs });
}

const BRANCH_STN_ID_SET = new Set(['14206', '14409', '14207', '14208', '14209', '14103', '14410']);

function parseAnyTimeMs(val) {
  if (!val) return NaN;
  const s = String(val).trim();
  if (/^\d{12}$/.test(s)) {
    return Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+09:00`);
  }
  return Date.parse(s);
}

function withDeadline(promise, timeoutMs, label = '응답 시간 초과') {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} (${Math.round(timeoutMs / 1000)}초 초과)`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function readEdgeCachedJson(pathWithQuery) {
  try {
    const cache = globalThis.caches?.default;
    if (!cache) return null;
    const keyReq = edgeCacheRequest(new URL('https://bionda.pages.dev' + pathWithQuery), false);
    const hit = await cache.match(keyReq);
    if (!hit || !hit.ok) return null;
    return await hit.json();
  } catch {
    return null;
  }
}

/**
 * STEP 3: 일 2회(08:00 · 18:00 KST) 정시 채널과 호환되는 경량 라이브 브리핑 JSON
 */
async function buildLiveBriefingPayload(env, { force = false } = {}, ctx = null) {
  const nowMs = Date.now();
  const edition = resolveBriefingEditionMeta(nowMs);
  const roadLine = getRoadLineCode(env);
  const [roadObsRes, roadRiskRes, short12Res, wrnRes] = await Promise.allSettled([
    getRoadKey(env)
      ? withDeadline(
          (!force ? readEdgeCachedJson(`/api/road-obs?line=${encodeURIComponent(roadLine)}`) : Promise.resolve(null))
            .then(hit => hit || fetchRoadStations(env, roadLine, force, ctx)),
          6500,
          '도로관측 조회 지연'
        )
      : Promise.resolve(null),
    getRoadKey(env)
      ? withDeadline(
          (!force ? readEdgeCachedJson('/api/road-risk?roadNum=012') : Promise.resolve(null))
            .then(hit => hit || fetchRoadRisk(env, '012', force)),
          7500,
          '012선 위험정보 조회 지연'
        )
      : Promise.resolve(null),
    getServiceKey(env)
      ? withDeadline(
          (!force ? readEdgeCachedJson('/api/short-term-12?roster=13') : Promise.resolve(null))
            .then(hit => hit || fetchShortTerm12(env, { force, refreshShort: force, refreshUltra: force })),
          11500,
          '13개소 단기예보 조회 지연'
        )
      : Promise.resolve(null),
    getServiceKey(env)
      ? withDeadline(fetchWrnNowList(env, force), 6000, '특보 조회 지연')
      : Promise.resolve([])
  ]);

  const roadObs = roadObsRes.status === 'fulfilled' ? roadObsRes.value : null;
  const roadRisk = roadRiskRes.status === 'fulfilled' ? roadRiskRes.value : null;
  const short12 = short12Res.status === 'fulfilled' ? short12Res.value : null;
  const wrnAll = wrnRes.status === 'fulfilled' && Array.isArray(wrnRes.value) ? wrnRes.value : [];

  const stations = (roadObs?.stations || [])
    .filter(s => BRANCH_STN_ID_SET.has(String(s?.stnId)))
    .sort((a, b) => (a.milepostKm || 0) - (b.milepostKm || 0))
    .map(s => ({
      stnId: String(s.stnId),
      name: s.name,
      km: s.milepostKm,
      tempC: s.temp,
      roadTempC: s.roadTemp,
      humidityPct: s.humidity,
      surfaceState: s.surfaceState || '건조'
    }));

  const activeWarnings = [];
  for (const p of CORRIDOR_WATCHED_PLACES) {
    const matched = sortWarnings(wrnAll.filter(w => warningMatchesPlace(w, p.name, p.lat, p.lon, new Map())));
    if (matched.length) {
      activeWarnings.push({ place: p.name, titles: matched.map(m => m.title) });
    }
  }

  const branch = roadRisk?.branchSummary || null;
  return {
    ok: true,
    schema: 'bionda-briefing-v2',
    mode: 'live-edge-cached',
    generatedAt: new Date(nowMs).toISOString(),
    generatedKst: isoKst(kst(nowMs)),
    edition,
    corridor: '고속국도 제12호선 광주대구선 (고령지사 관할 함양IC 95.0k ~ 옥포JC 176.0k)',
    shareStatusUrl: 'https://bionda.pages.dev/share/status.json',
    staticBriefingUrl: 'https://bionda.pages.dev/api/briefing.json',
    branchRoadRisk: branch ? {
      rangeLabel: branch.rangeLabel,
      maxIce: branch.maxIce,
      iceLabel: branch.iceLabel,
      iceCounts: branch.iceCounts,
      missingIceCount: branch.missingIceCount,
      frgTmKst: roadRisk?.sources?.frgTmKst || roadRisk?.tmKst || null,
      fogTmKst: roadRisk?.sources?.fogTmKst || null
    } : null,
    roadObsTm1: roadObs?.tm1 || null,
    corridorStations: stations,
    forecastSources: short12?.sources || null,
    windowKPIs: short12?.windowKPIs || null,
    activeWarnings
  };
}

/**
 * STEP 4: 전 데이터 파이프라인 신선도·불변식·시차 통합 진단 엔드포인트 (/api/data-health)
 * - 모바일·콜드 PoP에서도 단일 Worker 6소켓 경합으로 타임아웃되지 않도록 Edge Cache 우선 재사용 + 파이프라인별 개별 데드라인 적용
 */
async function buildDataHealthPayload(env, request, { force = false } = {}, ctx = null) {
  const nowMs = Date.now();
  const roadLine = getRoadLineCode(env);
  const edition = resolveBriefingEditionMeta(nowMs);

  const [roadObsRes, roadRiskRes, rwisRes, short12Res, wrnRes] = await Promise.allSettled([
    getRoadKey(env)
      ? withDeadline(
          (!force ? readEdgeCachedJson(`/api/road-obs?line=${encodeURIComponent(roadLine)}`) : Promise.resolve(null))
            .then(hit => hit || fetchRoadStations(env, roadLine, force, ctx)),
          6500,
          '도로관측 조회 지연'
        )
      : Promise.reject(new Error('ROAD_KEY_MISSING')),
    getRoadKey(env)
      ? withDeadline(
          (!force ? readEdgeCachedJson('/api/road-risk?roadNum=012') : Promise.resolve(null))
            .then(hit => hit || fetchRoadRisk(env, '012', force)),
          7500,
          '012선 위험정보 조회 지연'
        )
      : Promise.reject(new Error('ROAD_KEY_MISSING')),
    withDeadline(
      handleRwisFetch(new Request(`https://bionda.pages.dev/api/rwis${force ? '?refresh=1' : ''}`), env, ctx).then(r => r.json()),
      8000,
      'RWIS 조회 지연'
    ),
    getServiceKey(env)
      ? withDeadline(
          (!force
            ? readEdgeCachedJson('/api/short-term-12?roster=13').then(hit => hit || readEdgeCachedJson('/api/short-term-12'))
            : Promise.resolve(null)
          ).then(hit => hit || fetchShortTerm12(env, { force, refreshShort: false, refreshUltra: force })),
          11500,
          '13개소 단기예보 조회 지연'
        )
      : Promise.reject(new Error('SERVICE_KEY_MISSING')),
    getServiceKey(env)
      ? withDeadline(fetchWrnNowList(env, force), 6000, '특보 조회 지연')
      : Promise.reject(new Error('SERVICE_KEY_MISSING'))
  ]);

  const ageMinOf = raw => {
    const ms = parseAnyTimeMs(raw);
    return Number.isFinite(ms) ? Math.max(0, Math.round((nowMs - ms) / 60000)) : null;
  };

  // 1) 도로기상관측 (1분 주기)
  let roadObsPipe;
  if (roadObsRes.status === 'fulfilled' && roadObsRes.value?.stations?.length) {
    const ro = roadObsRes.value;
    const ageMin = ageMinOf(ro.tm1);
    const branchCnt = ro.stations.filter(s => BRANCH_STN_ID_SET.has(String(s?.stnId)) && (s.roadTemp !== null || s.temp !== null)).length;
    const status = ro.stale || (ageMin !== null && ageMin > 12) ? 'degraded' : 'healthy';
    roadObsPipe = {
      status,
      tm1: ro.tm1 || null,
      ageMinutes: ageMin,
      totalStations: ro.stations.length,
      branchStationsActive: branchCnt,
      branchStationsExpected: 7,
      stale: Boolean(ro.stale)
    };
  } else {
    roadObsPipe = { status: 'critical', error: errMessage(roadObsRes.reason || '도로관측 미수신') };
  }

  // 2) 012선 도로살얼음 위험정보 ZIP (5분 주기)
  let roadRiskPipe;
  if (roadRiskRes.status === 'fulfilled' && roadRiskRes.value?.ok) {
    const rr = roadRiskRes.value;
    const br = rr.branchSummary || {};
    const frgTm = rr.sources?.frgTmKst || rr.tmKst || null;
    const fogTm = rr.sources?.fogTmKst || null;
    const frgMs = parseAnyTimeMs(frgTm);
    const fogMs = parseAnyTimeMs(fogTm);
    const fogLagMin = (Number.isFinite(frgMs) && Number.isFinite(fogMs)) ? Math.round((frgMs - fogMs) / 60000) : 0;
    const ageMin = ageMinOf(frgTm);
    const sumCnt = Array.isArray(br.iceCounts) ? br.iceCounts.reduce((a, b) => a + b, 0) : 0;
    const invariantOk = br.total1km === (sumCnt + (br.missingIceCount || 0));
    const status = (rr.stale || !invariantOk || (ageMin !== null && ageMin > 20)) ? 'degraded' : 'healthy';
    roadRiskPipe = {
      status,
      frgTmKst: frgTm,
      fogTmKst: fogTm,
      fogLagMinutes: fogLagMin,
      ageMinutes: ageMin,
      branchRange: br.rangeLabel || '함양IC(95.0k)~옥포JC(176.0k)',
      branchMaxIce: br.maxIce,
      branchIceLabel: br.iceLabel,
      total1km: br.total1km ?? 0,
      missingIceCount: br.missingIceCount ?? 0,
      invariantOk,
      stale: Boolean(rr.stale)
    };
  } else {
    roadRiskPipe = { status: 'critical', error: errMessage(roadRiskRes.reason || '012선 위험정보 미수신') };
  }

  // 3) 기상청 RWIS 실시간 (FR/VR)
  let rwisPipe;
  if (rwisRes.status === 'fulfilled' && rwisRes.value?.ok) {
    const rw = rwisRes.value.rwis || rwisRes.value;
    const frTm = rw?.tm?.FR || (typeof rw?.tm === 'string' ? rw.tm : null);
    const vrTm = rw?.tm?.VR || null;
    const frMs = parseAnyTimeMs(frTm);
    const vrMs = parseAnyTimeMs(vrTm);
    const vrLagMin = (Number.isFinite(frMs) && Number.isFinite(vrMs)) ? Math.round((frMs - vrMs) / 60000) : null;
    const ageMin = ageMinOf(frTm);
    const zoneCnt = Array.isArray(rw?.zones) ? rw.zones.length : 0;
    const status = (zoneCnt < 16 || (ageMin !== null && ageMin > 25)) ? 'degraded' : 'healthy';
    rwisPipe = {
      status,
      frTm,
      vrTm,
      vrLagMinutes: vrLagMin,
      ageMinutes: ageMin,
      zoneCount: zoneCnt,
      expectedZoneCount: 16
    };
  } else {
    rwisPipe = { status: 'degraded', error: errMessage(rwisRes.reason || rwisRes.value?.error || 'RWIS 지연') };
  }

  // 4) 13개소 단기·초단기예보
  let short13Pipe;
  if (short12Res.status === 'fulfilled' && short12Res.value?.ok) {
    const s12 = short12Res.value;
    const complete = (s12.regions || []).filter(r => Array.isArray(r.hours) && r.hours.length > 0).length;
    const mixed = Boolean(s12.sources?.mixedGeneration);
    const isFb = Boolean(s12.sources?.isFallback);
    const status = (complete < 13 || mixed || isFb) ? 'degraded' : 'healthy';
    short13Pipe = {
      status,
      shortBase: s12.sources?.shortBase || null,
      ultraBase: s12.sources?.ultraBase || null,
      shortAgeMinutes: ageMinOf(s12.sources?.shortBase),
      ultraAgeMinutes: ageMinOf(s12.sources?.ultraBase),
      completeRegions: complete,
      expectedRegions: 13,
      mixedGeneration: mixed,
      isFallback: isFb,
      snapshotId: s12.sources?.snapshotId || null
    };
  } else {
    short13Pipe = { status: 'critical', error: errMessage(short12Res.reason || '13개소 단기예보 미수신') };
  }

  // 5) 기상특보
  let warningsPipe;
  if (wrnRes.status === 'fulfilled' && Array.isArray(wrnRes.value)) {
    const list = wrnRes.value;
    warningsPipe = {
      status: list._stale ? 'degraded' : 'healthy',
      confirmed: !list._stale,
      nationalActiveCount: list.length,
      stale: Boolean(list._stale)
    };
  } else {
    warningsPipe = { status: 'degraded', error: errMessage(wrnRes.reason || '특보 조회 지연') };
  }

  const allStatuses = [roadObsPipe.status, roadRiskPipe.status, rwisPipe.status, short13Pipe.status, warningsPipe.status];
  const overallStatus = allStatuses.includes('critical')
    ? 'critical'
    : allStatuses.includes('degraded')
      ? 'degraded'
      : 'healthy';

  return {
    ok: true,
    checkedAt: new Date(nowMs).toISOString(),
    checkedKst: isoKst(kst(nowMs)),
    overallStatus,
    runtime: {
      platform: 'cloudflare-workers',
      forecastConfigured: Boolean(getServiceKey(env)),
      roadConfigured: Boolean(getRoadKey(env)),
      radarConfigured: Boolean(getRadarKey(env)),
      cctvConfigured: isCctvConfigured(env)
    },
    pipelines: {
      roadObs: roadObsPipe,
      roadRisk012: roadRiskPipe,
      rwis: rwisPipe,
      shortTerm13: short13Pipe,
      warnings: warningsPipe,
      briefing: {
        status: 'healthy',
        ...edition,
        shareStatusUrl: 'https://bionda.pages.dev/share/status.json',
        staticBriefingUrl: 'https://bionda.pages.dev/api/briefing.json',
        liveBriefingUrl: 'https://bionda.pages.dev/api/briefing'
      }
    }
  };
}

async function fetchRoadRisk(env, roadNum = '012', bypassCache = false) {
  const key = getRoadKey(env);
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const cleanNum = String(roadNum || '012').replace(/\D/g, '').padStart(3, '0').slice(-3);
  const cacheKey = `road-risk|${cleanNum}`;
  const staleKey = `road-risk-last-good|${cleanNum}`;
  const hit = !bypassCache ? getCached(cacheKey) : null;
  if (hit) return hit;

  return withInFlight(bypassCache ? `${cacheKey}|bypass` : cacheKey, async () => {
    const now = Date.now();
    // KMA APIHub 도로살얼음 위험정보는 5분 주기로 생산되므로 3분 전부터 5분 슬롯을 탐색하고 4분 캐시로 최신성 유지
    const offsetsMinutes = [3, 5, 10, 15, 20];
    for (const off of offsetsMinutes) {
      try {
        const { tmUtc, tmKst } = utcFiveMinSlot(now - off * 60000);
        const u = new URL('https://apihub.kma.go.kr/api/typ04/url/road_file_down.php');
        u.searchParams.set('tm', tmUtc);
        u.searchParams.set('roadNum', cleanNum);
        u.searchParams.set('authKey', deEncodedKey(key));
        const r = await fetchWithTimeout(u.toString(), {}, 5500);
        if (!r.ok) continue;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) continue;
        const files = await extractZipTextEntries(bytes, fn => /_(1KM)_(FRG|FOG)_/i.test(fn));
        const frgEntry = Object.entries(files).find(([k]) => /_FRG_/i.test(k));
        const fogEntry = Object.entries(files).find(([k]) => /_FOG_/i.test(k));
        if (!frgEntry && !fogEntry) continue;
        const frgRows = frgEntry ? parseRoadRiskCsv(frgEntry[1]) : [];
        const fogRows = fogEntry ? parseRoadRiskCsv(fogEntry[1]) : [];
        if (!frgRows.length && !fogRows.length) continue;
        const frgMeta = frgEntry ? parseZipEntryTimestamp(frgEntry[0]) : null;
        const fogMeta = fogEntry ? parseZipEntryTimestamp(fogEntry[0]) : null;
        const payload = buildRoadRiskPayload({
          roadNum: cleanNum,
          tmUtc,
          tmKst,
          frgTmUtc: frgMeta?.tmUtc || null,
          frgTmKst: frgMeta?.tmKst || null,
          fogTmUtc: fogMeta?.tmUtc || null,
          fogTmKst: fogMeta?.tmKst || null,
          frgRows,
          fogRows
        });
        setCached(cacheKey, payload, 4 * 60000);
        setCached(staleKey, payload, 25 * 60000);
        return payload;
      } catch (e) {
        console.warn('[fetchRoadRisk] err off=' + off, errMessage(e));
      }
    }
    const stale = getCached(staleKey);
    if (stale) return { ...stale, stale: true, isFallback: true };
    throw new Error('도로 위험기상정보(FRG/FOG) ZIP 자료를 가져오지 못했습니다.');
  });
}

async function getObservationForPlace(env, lat, lon, bypassCache = false) {
  const cacheKey = `obs|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  const hit = !bypassCache ? getCached(cacheKey) : null;
  if (hit) return hit;

  let roadMatch = null;
  try {
    const roadData = await fetchRoadStations(env, getRoadLineCode(env), bypassCache);
    const m = matchRoadStation(lat, lon, roadData.stations);
    if (m && m.distanceKm <= 28) roadMatch = m;
  } catch {}

  let kmaNcst = null;
  const needsNcstFallback = !roadMatch || roadMatch.temp === null || roadMatch.humidity === null;
  try {
    const grid = latlonToGrid(lat, lon);
    const ncstBase = baseObservation(Date.now());
    const cachedNcstItems = !bypassCache ? getCached(`kma|getUltraSrtNcst|${grid.nx}|${grid.ny}|${datePart(ncstBase)}|${timePart(ncstBase)}`) : null;
    const res = cachedNcstItems
      ? { items: cachedNcstItems, base: isoKst(ncstBase) }
      : needsNcstFallback
        ? await fetchWithFallback(env, 'getUltraSrtNcst', grid, ncstBase, 60, bypassCache)
        : null;
    kmaNcst = parseNcstValues(res, grid);
  } catch {}

  const out = mergeObservationResult(roadMatch, kmaNcst);
  setCached(cacheKey, out, 90000);
  return out;
}

async function fetchOverviewBundle(env, { placesParam = '', line = getRoadLineCode(env), roadNum = '012', force = false, hard = false } = {}, ctx = null) {
  const places = parseOverviewPlacesParam(placesParam);
  if (!places.length) throw new Error('조회할 유효한 국내 좌표가 없습니다.');
  const now = Date.now();
  const sBase = baseShort(now);
  const uBase = baseUltra(now);
  const oBase = baseObservation(now);
  const bypassBundle = Boolean(force || hard);
  const bypassHeavy = Boolean(hard);
  const bundleKey = `bundle|${line}|${roadNum}|${canonicalOverviewPlacesKey(places)}|${timePart(uBase)}|${timePart(sBase)}`;
  const hit = !bypassBundle ? getCached(bundleKey) : null;
  if (hit) return hit;

  return withInFlight(bypassHeavy ? `${bundleKey}|hard` : bypassBundle ? `${bundleKey}|force` : bundleKey, async () => {
    const uniqueGrids = new Map();
    for (const p of places) {
      const gk = `${p.grid.nx},${p.grid.ny}`;
      if (!uniqueGrids.has(gk)) uniqueGrids.set(gk, p.grid);
    }
    const gridEntries = [...uniqueGrids.entries()];

    // 1) 도로관측 · 012위험 · 특보 · 첫 번째 격자(ultra probe) 병렬 시작 후 나머지 격자는 2개씩 분할 (Cloudflare 6연결 한도 내 타임아웃 방지)
    const roadPromise = getRoadKey(env) ? fetchRoadStations(env, line, bypassBundle, ctx).catch(() => null) : Promise.resolve(null);
    const riskPromise = getRoadKey(env) ? fetchRoadRisk(env, roadNum, bypassHeavy).catch(() => null) : Promise.resolve(null);
    const wrnPromise = fetchWrnNowList(env, bypassBundle).catch(() => null);

    const gridResults = new Map();
    let forecastPromise = Promise.resolve();
    if (getServiceKey(env) && gridEntries.length) {
      let resolvedUBase = null;
      let ultraProbePromise = null;
      const fetchBundleUltra = async (grid) => {
        if (!resolvedUBase) {
          if (!ultraProbePromise) {
            ultraProbePromise = fetchWithFallback(env, 'getUltraSrtFcst', grid, uBase, 60, bypassBundle)
              .then(res => {
                resolvedUBase = res.notice ? new Date(uBase.getTime() - 60 * 60000) : uBase;
                return { firstKey: `${grid.nx},${grid.ny}`, res };
              })
              .catch(err => {
                ultraProbePromise = null;
                throw err;
              });
          }
          const probed = await ultraProbePromise;
          if (probed.firstKey === `${grid.nx},${grid.ny}`) return probed.res;
        }
        const activeBase = resolvedUBase || uBase;
        return { items: await fetchKma(env, 'getUltraSrtFcst', grid, activeBase, 6000, bypassBundle), base: isoKst(activeBase) };
      };

      const roadMatchGate = roadPromise.then(roadData => {
        const placeRoadMatches = new Map();
        const gridNeedsNcst = new Set();
        for (const p of places) {
          const gk = `${p.grid.nx},${p.grid.ny}`;
          const rm = roadData?.stations?.length ? matchRoadStation(p.lat, p.lon, roadData.stations) : null;
          const validRm = rm && rm.distanceKm <= 28 ? rm : null;
          placeRoadMatches.set(p.key, validRm);
          if (!validRm || validRm.temp === null || validRm.humidity === null) {
            gridNeedsNcst.add(gk);
          }
        }
        return { roadData, placeRoadMatches, gridNeedsNcst };
      });

      const runGrid = async ([gk, grid]) => {
        const ncstPromise = roadMatchGate.then(({ gridNeedsNcst }) =>
          gridNeedsNcst.has(gk) ? fetchWithFallback(env, 'getUltraSrtNcst', grid, oBase, 60, bypassBundle) : null
        );
        const requests = await Promise.allSettled([
          fetchBundleUltra(grid),
          fetchWithFallback(env, 'getVilageFcst', grid, sBase, 180, bypassHeavy),
          ncstPromise
        ]);
        gridResults.set(gk, requests);
      };

      forecastPromise = (async () => {
        await runGrid(gridEntries[0]);
        const rest = gridEntries.slice(1);
        for (let idx = 0; idx < rest.length; idx += 2) {
          await Promise.allSettled(rest.slice(idx, idx + 2).map(runGrid));
        }
      })();
    }

    const [roadData, roadRisk, warningResult] = await Promise.all([roadPromise, riskPromise, wrnPromise, forecastPromise]);
    const allWarnings = warningResult || [];
    const hasSubZones = allWarnings.some(w => w.regUpKo && w.regKo !== w.regUpKo);
    const capPolyMap = hasSubZones ? await getCapPolygonMap(bypassHeavy) : new Map();

    const placeRoadMatches = new Map();
    for (const p of places) {
      const rm = roadData?.stations?.length ? matchRoadStation(p.lat, p.lon, roadData.stations) : null;
      placeRoadMatches.set(p.key, rm && rm.distanceKm <= 28 ? rm : null);
    }

    const items = {};
    for (const p of places) {
      const gk = `${p.grid.nx},${p.grid.ny}`;
      const reqs = gridResults.get(gk);
      const rm = placeRoadMatches.get(p.key) || null;
      const ncstSettled = reqs?.[2]?.status === 'fulfilled' && reqs[2].value ? reqs[2] : null;
      const kmaNcst = ncstSettled ? parseNcstValues(ncstSettled.value, p.grid) : null;
      const observation = (rm || kmaNcst) ? mergeObservationResult(rm, kmaNcst) : null;

      let fcst = null;
      if (reqs && (reqs[0].status === 'fulfilled' || reqs[1].status === 'fulfilled')) {
        try {
          fcst = buildForecastResult(p.grid, now, [
            reqs[0],
            reqs[1],
            ncstSettled || { status: 'rejected', reason: new Error('road obs matched') }
          ]);
        } catch {}
      }

      const matchedWrn = sortWarnings(allWarnings.filter(w => warningMatchesPlace(w, p.name, p.lat, p.lon, capPolyMap)));
      items[p.key] = {
        name: p.name,
        observation,
        forecast: fcst,
        warningsConfirmed: Boolean(getServiceKey(env)) && warningResult !== null && !allWarnings._stale,
        warnings: matchedWrn
      };
    }

    const payload = {
      ok: true,
      mode: 'overview-bundle',
      updatedAt: new Date(now).toISOString(),
      roadLine: String(line),
      roadObsTm: roadData?.tm1 || null,
      roadStations: roadData?.stations || [],
      roadRisk,
      items
    };
    setCached(bundleKey, payload, roadData?.stations?.length ? 45000 : 15000);
    return payload;
  });
}

async function fetchWrnNowList(env, bypassCache = false) {
  const key = getServiceKey(env);
  if (!key) return [];
  const cacheKey = 'kma-wrn-now';
  const staleKey = 'kma-wrn-now-last-good';
  const hit = !bypassCache ? getCached(cacheKey) : null;
  if (hit) return hit;
  return withInFlight(bypassCache ? `${cacheKey}|bypass` : cacheKey, async () => {
    try {
      const u = new URL('https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php');
      u.searchParams.set('fe', 'f');
      u.searchParams.set('tm', '');
      u.searchParams.set('disp', '0');
      u.searchParams.set('help', '2');
      u.searchParams.set('authKey', deEncodedKey(key));
      const r = await fetchWithTimeout(u.toString(), {}, 6500);
      if (!r.ok) throw new Error(`KMA 특보 응답 오류 HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const text = new TextDecoder('euc-kr').decode(bytes);
      const parsed = parseWrnNow(text);
      setCached(cacheKey, parsed, 90000);
      setCached(staleKey, parsed, 20 * 60000);
      return parsed;
    } catch (e) {
      console.warn('[fetchWrnNowList]', errMessage(e));
      const stale = getCached(staleKey);
      if (stale) {
        const out = [...stale];
        Object.defineProperty(out, '_stale', { value: true, enumerable: false });
        setCached(cacheKey, out, 45000);
        return out;
      }
      throw e;
    }
  });
}

async function fetchCapXml(file = '', bypassCache = false) {
  const cleanFile = String(file || '').trim();
  if (cleanFile && !/^KR\.W\d+_\d{12}_[A-Z]{2,6}_\d+_(EN|KR)\.xml$/.test(cleanFile)) {
    throw new Error('유효하지 않은 CAP XML 파일명입니다.');
  }
  const cacheKey = `cap|${cleanFile || 'rss'}`;
  const hit = !bypassCache ? getCached(cacheKey) : null;
  if (hit) return hit;
  return withInFlight((bypassCache && !cleanFile) ? `${cacheKey}|bypass` : cacheKey, async () => {
    const targetUrl = cleanFile
      ? `https://www.weather.go.kr/w/repositary/xml/wrn/xml/${cleanFile}`
      : 'https://www.weather.go.kr/w/rss/cap/warning.do';
    const r = await fetchWithTimeout(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 10000);
    if (!r.ok) throw new Error(`기상청 CAP 응답 오류 HTTP ${r.status}`);
    const xml = await r.text();
    setCached(cacheKey, xml, cleanFile ? 30 * 60000 : 60000);
    return xml;
  });
}

async function getCapPolygonMap(bypassCache = false) {
  const cached = !bypassCache ? getCached('kma-cap-polygons') : null;
  if (cached) return cached;
  const polyMap = new Map();
  try {
    const rssXml = await fetchCapXml('', bypassCache);
    const links = extractCapLinksFromRss(rssXml, 8);
    const docs = await Promise.allSettled(links.map(f => fetchCapXml(f, false)));
    for (const res of docs) {
      if (res.status === 'fulfilled') populateCapPolygons(res.value, polyMap);
    }
  } catch {}
  setCached('kma-cap-polygons', polyMap, 120000);
  return polyMap;
}

async function radarImage(env, bypassCache = false) {
  const radarKey = getRadarKey(env);
  if (!radarKey) throw new Error('KMA_RADAR_KEY 미설정');
  const cacheKey = 'radar-visual';
  const cache = !bypassCache ? getCached(cacheKey) : null;
  if (cache) return cache;
  return withInFlight(bypassCache ? `${cacheKey}|bypass` : cacheKey, async () => {
    const u = new URL('https://apihub.kma.go.kr/api/typ03/cgi/rdr/nph-rdr_cmp1_img');
    const p = { cmp: 'HSR', qcd: 'HSLP', obs: 'ECHD', color: 'C4', aws: '0', map: 'HR', grid: '2', legend: '1', size: '800', itv: '5', zoom_level: '0', zoom_x: '0000000', zoom_y: '0000000', gov: '', authKey: deEncodedKey(radarKey) };
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    const r = await fetchWithTimeout(u.toString(), {}, 12000);
    if (!r.ok) throw new Error(`레이더 서버 오류 HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const type = detectRadarImageType(bytes);
    const out = { bytes, type };
    setCached(cacheKey, out, 4 * 60000);
    return out;
  });
}

export function __resetWorkerCaches() {
  SHARED_CACHE.clear();
  INFLIGHT.clear();
  REQUESTS.clear();
}

export default {
  async fetch(request, env = {}, ctx = null) {
    const requestUrl = new URL(request.url);
    const pathname = requestUrl.pathname;

    // 광주대구선 RWIS·CCTV 대시보드는 /rwis, /api/rwis 아래로 위임합니다. (프리픽스 제거 후 전달)
    const rwisPrefix = matchRwisPrefix(pathname);
    if (rwisPrefix) {
      return handleRwisFetch(rewriteRwisRequest(request, requestUrl, rwisPrefix), env, ctx);
    }

    if (request.method === 'OPTIONS') {
      if (pathname.startsWith('/api/') || pathname === '/') {
        return new Response(null, { status: 204, headers: buildCorsHeaders(request, env) });
      }
      return jsonResponse(request, env, 405, { error: '허용되지 않는 요청' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(request, env, 405, { error: '허용되지 않는 요청' });
    }

    const roadLine = getRoadLineCode(env);

    if (pathname === '/' || pathname === '/api/health') {
      return jsonResponse(request, env, 200, {
        status: 'ok',
        runtime: 'cloudflare-workers',
        forecastConfigured: !!getServiceKey(env),
        radarConfigured: !!getRadarKey(env),
        roadConfigured: !!getRoadKey(env),
        cctvConfigured: isCctvConfigured(env),
        roadLine
      });
    }

    if (!pathname.startsWith('/api/')) {
      return jsonResponse(request, env, 404, { error: 'API를 찾지 못했습니다.' });
    }

    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    if (!allow(clientIp)) {
      return jsonResponse(request, env, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 이용해 주세요.' });
    }

    if (pathname === '/api/cctv') {
      const refresh =
        requestUrl.searchParams.get('refresh') === '1' ||
        requestUrl.searchParams.get('refresh') === 'true' ||
        requestUrl.searchParams.get('hard') === '1';
      const cctvCacheKey = 'its-cctv-corridor';
      const cctvEdgeReq = edgeCacheRequest(new URL(requestUrl.origin + '/api/cctv'), false);
      const edgeCache = globalThis.caches?.default || null;

      if (!refresh) {
        const memHit = getCached(cctvCacheKey);
        if (memHit) {
          return jsonResponse(request, env, 200, { ...memHit, cache: 'HIT' }, {
            'X-Cache': 'HIT',
            'Cache-Control': `public, max-age=${CCTV_CACHE_TTL_SECONDS}`
          });
        }
        if (edgeCache) {
          try {
            const cached = await edgeCache.match(cctvEdgeReq);
            if (cached) {
              const payload = await cached.json();
              setCached(cctvCacheKey, payload, CCTV_CACHE_TTL_SECONDS * 1000);
              return jsonResponse(request, env, 200, { ...payload, cache: 'HIT' }, {
                'X-Cache': 'HIT',
                'Cache-Control': `public, max-age=${CCTV_CACHE_TTL_SECONDS}`
              });
            }
          } catch {}
        }
      }

      let payload;
      try {
        payload = refresh
          ? await buildCctvPayload(env)
          : await withInFlight(cctvCacheKey, () => buildCctvPayload(env));
      } catch (err) {
        const code = (err && err.code) || 'UNKNOWN_ERROR';
        const status = code === 'ITS_API_KEY_MISSING' ? 500 : 502;
        return jsonResponse(
          request,
          env,
          status,
          {
            ok: false,
            error: code,
            message: (err && err.message) || '알 수 없는 오류',
            detail: (err && err.detail) || null,
            hint:
              code === 'ITS_API_KEY_MISSING'
                ? 'Worker 시크릿 ITS_API_KEY를 설정한 뒤 다시 호출하세요. (wrangler secret put ITS_API_KEY)'
                : 'Cloudflare Workers에서 openapi.its.go.kr:9443 연결이 막히는 경우가 있습니다. 그때는 NAS나 GitHub Actions에서 같은 JSON을 주기적으로 받아 KV/R2/정적 호스팅에 올리고, Worker 환경변수 CCTV_SOURCE_URL 에 그 주소를 지정하세요. (README_cctv.md 참고)',
            at: new Date().toISOString()
          },
          { 'X-Cache': 'BYPASS' }
        );
      }

      setCached(cctvCacheKey, payload, CCTV_CACHE_TTL_SECONDS * 1000);
      if (edgeCache) {
        const storable = new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${CCTV_CACHE_TTL_SECONDS}`
          }
        });
        putEdgeCache(ctx, cctvEdgeReq, storable);
      }

      const mode = refresh ? 'REFRESH' : 'MISS';
      return jsonResponse(request, env, 200, { ...payload, cache: mode }, {
        'X-Cache': mode,
        'Cache-Control': `public, max-age=${CCTV_CACHE_TTL_SECONDS}`
      });
    }

    // Check Edge Cache API (normalized radar key unless force / hard / refresh / refreshShort / refreshUltra)
    const isForced = requestUrl.searchParams.get('force') === '1' || requestUrl.searchParams.get('refresh') === '1';
    const isHard = requestUrl.searchParams.get('hard') === '1';
    const bypassNow = isForced || isHard;
    const bypassEdge = bypassNow || requestUrl.searchParams.get('refreshShort') === '1' || requestUrl.searchParams.get('refreshUltra') === '1';
    const cacheKeyReq = edgeCacheRequest(requestUrl, pathname === '/api/radar');
    if (!bypassEdge) {
      const edgeHit = await matchEdgeCache(request, env, cacheKeyReq);
      if (edgeHit) return edgeHit;
    }

    if (pathname === '/api/forecast') {
      const lat = Number(requestUrl.searchParams.get('lat'));
      const lon = Number(requestUrl.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 32 || lat > 39.5 || lon < 124 || lon > 132) {
        return jsonResponse(request, env, 400, { error: '유효한 국내 위도·경도를 입력해 주세요.' });
      }
      if (!getServiceKey(env)) {
        return jsonResponse(request, env, 503, { code: 'KEY_MISSING', error: '운영자가 기상청 예보 API 키를 등록하지 않았습니다.' });
      }
      try {
        const value = await forecast(env, lat, lon, bypassNow);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': bypassNow ? 'no-store' : 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
        });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/overview-bundle') {
      if (!getServiceKey(env) && !getRoadKey(env)) {
        return jsonResponse(request, env, 503, { code: 'KEY_MISSING', error: '운영자가 기상청 API 키를 등록하지 않았습니다.' });
      }
      try {
        const line = requestUrl.searchParams.get('line') || roadLine;
        const roadNum = requestUrl.searchParams.get('roadNum') || '012';
        const placesParam = requestUrl.searchParams.get('places') || '';
        const value = await fetchOverviewBundle(env, { placesParam, line, roadNum, force: bypassNow, hard: isHard }, ctx);
        const noCacheBundle = bypassNow || !value.roadStations?.length;
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': noCacheBundle ? 'no-store' : 'public, max-age=30, s-maxage=45'
        });
        if (!noCacheBundle) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/short-term-12') {
      if (!getServiceKey(env)) {
        return jsonResponse(request, env, 503, { code: 'KEY_MISSING', error: '운영자가 기상청 예보 API 키를 등록하지 않았습니다.' });
      }
      try {
        const rsParam = requestUrl.searchParams.get('refreshShort');
        const ruParam = requestUrl.searchParams.get('refreshUltra');
        const refreshShort = isHard ? true : (rsParam !== null ? rsParam === '1' : isForced);
        const refreshUltra = isHard ? true : (ruParam !== null ? ruParam === '1' : isForced);
        const value = await fetchShortTerm12(env, { force: bypassNow, refreshShort, refreshUltra });
        const nowMs = Date.now();
        const kstMin = kst(nowMs).getUTCMinutes();
        const secsToHour = Math.max(5, Math.ceil((3600000 - (nowMs % 3600000)) / 1000));
        // 35분(HH:35:00) 경계에 KMA 새 초단기예보가 열리므로 Edge/Browser 캐시가 35분을 넘기지 않도록 제한
        const minsPast35 = kstMin < 35 ? (35 - kstMin) * 60 : 3600;
        const expectedShortIso = isoKst(baseShort(nowMs));
        const expectedUltraIso = isoKst(baseUltra(nowMs));
        const pendingShortRelease = !value?.sources?.shortBase || Date.parse(value.sources.shortBase) < Date.parse(expectedShortIso);
        const pendingUltraRelease = !value?.sources?.ultraBase || Date.parse(value.sources.ultraBase) < Date.parse(expectedUltraIso);
        const completeRegions = (value?.regions || []).filter(r => Array.isArray(r.hours) && r.hours.length > 0).length;
        const isMixed = Boolean(value?.sources?.mixedGeneration);
        const capSec = (pendingShortRelease || pendingUltraRelease) ? 45 : 300;
        const maxAge = Math.min(180, secsToHour, minsPast35, capSec);
        const sMaxAge = Math.min(300, secsToHour, minsPast35, capSec);
        const bypassAllCache = bypassNow || refreshShort || refreshUltra || completeRegions < 13 || isMixed;
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': bypassAllCache ? 'no-store' : `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=60`
        });
        if (!bypassAllCache) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/road-obs') {
      if (!getRoadKey(env)) {
        return jsonResponse(request, env, 503, { code: 'ROAD_KEY_MISSING', error: '도로기상관측 API 키가 설정되지 않았습니다.' });
      }
      const line = requestUrl.searchParams.get('line') || roadLine;
      try {
        const value = await fetchRoadStations(env, line, bypassNow, ctx);
        const skipCache = bypassNow || Boolean(value?.stale);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': skipCache ? 'no-store' : 'public, max-age=30, s-maxage=45'
        });
        if (!skipCache) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/road-obs-trend') {
      if (!getRoadKey(env)) {
        return jsonResponse(request, env, 503, { code: 'ROAD_KEY_MISSING', error: '도로기상관측 API 키가 설정되지 않았습니다.' });
      }
      const line = requestUrl.searchParams.get('line') || roadLine;
      const hours = Number(requestUrl.searchParams.get('hours')) || 6;
      try {
        const value = await fetchRoadStationsTrend(env, line, hours, bypassNow, ctx);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': bypassNow ? 'no-store' : 'public, max-age=300, s-maxage=600, stale-while-revalidate=300'
        });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/road-obs-history') {
      if (!getRoadKey(env)) {
        return jsonResponse(request, env, 503, { code: 'ROAD_KEY_MISSING', error: '도로기상관측 API 키가 설정되지 않았습니다.' });
      }
      const line = requestUrl.searchParams.get('line') || roadLine;
      const hours = Number(requestUrl.searchParams.get('hours')) || 12;
      const stepMin = Number(requestUrl.searchParams.get('stepMin')) || 30;
      const endMsRaw = requestUrl.searchParams.get('endMs');
      const endMs = endMsRaw !== null ? Number(endMsRaw) : Date.now();
      try {
        const value = await fetchRoadStationsHistoryChunk(env, { line, endMs, hours, stepMin, force: bypassNow }, ctx);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': bypassNow ? 'no-store' : 'public, max-age=120, s-maxage=300'
        });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/briefing') {
      try {
        const value = await buildLiveBriefingPayload(env, { force: bypassNow }, ctx);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': bypassNow ? 'no-store' : 'public, max-age=300, s-maxage=1800, stale-while-revalidate=600'
        });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/data-health') {
      try {
        const value = await buildDataHealthPayload(env, request, { force: bypassNow }, ctx);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': bypassNow ? 'no-store' : 'public, max-age=30, s-maxage=45'
        });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/road-risk') {
      if (!getRoadKey(env)) {
        return jsonResponse(request, env, 503, { code: 'ROAD_KEY_MISSING', error: '도로 위험기상정보 API 키가 설정되지 않았습니다.' });
      }
      const roadNum = requestUrl.searchParams.get('roadNum') || '012';
      try {
        const value = await fetchRoadRisk(env, roadNum, bypassNow);
        const latRaw = requestUrl.searchParams.get('lat');
        const lonRaw = requestUrl.searchParams.get('lon');
        let out = value;
        if (latRaw !== null && lonRaw !== null) {
          const lat = Number(latRaw), lon = Number(lonRaw);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            out = { ...value, customPlaceRisk: matchStationRiskForCoord(lat, lon, value.stationRisks, null, null, 6) };
          }
        }
        const skipRiskCache = bypassNow || Boolean(out?.stale);
        const res = jsonResponse(request, env, 200, out, {
          'Cache-Control': skipRiskCache ? 'no-store' : 'public, max-age=120, s-maxage=210'
        });
        if (!skipRiskCache) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/observation') {
      const lat = Number(requestUrl.searchParams.get('lat'));
      const lon = Number(requestUrl.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 32 || lat > 39.5 || lon < 124 || lon > 132) {
        return jsonResponse(request, env, 400, { error: '유효한 국내 위도·경도를 입력해 주세요.' });
      }
      try {
        const obs = await getObservationForPlace(env, lat, lon, bypassNow);
        const res = jsonResponse(request, env, 200, obs, {
          'Cache-Control': bypassNow ? 'no-store' : 'public, max-age=60, s-maxage=90'
        });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/kma-cap') {
      const file = requestUrl.searchParams.get('file') || '';
      try {
        const xml = await fetchCapXml(file, bypassNow && !file);
        const headers = buildCorsHeaders(request, env);
        headers.set('Content-Type', 'application/xml; charset=utf-8');
        headers.set('Cache-Control', bypassNow ? 'no-store' : (file ? 'public, max-age=1800, s-maxage=1800' : 'public, max-age=60, s-maxage=60'));
        const res = new Response(request.method === 'HEAD' ? null : xml, { status: 200, headers });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/warnings') {
      const placesParam = (requestUrl.searchParams.get('places') || '').trim();
      const name = (requestUrl.searchParams.get('name') || '').trim();
      const latRaw = requestUrl.searchParams.get('lat');
      const lonRaw = requestUrl.searchParams.get('lon');
      const lat = latRaw !== null ? Number(latRaw) : NaN;
      const lon = lonRaw !== null ? Number(lonRaw) : NaN;
      try {
        const parsedPlaces = placesParam ? parseOverviewPlacesParam(placesParam) : null;
        if (placesParam && (!parsedPlaces || !parsedPlaces.length)) {
          return jsonResponse(request, env, 400, { error: '조회할 유효한 국내 좌표가 없습니다.' });
        }
        const all = await fetchWrnNowList(env, bypassNow);
        const isStale = Boolean(all._stale);
        const hasSubZones = all.some(w => w.regUpKo && w.regKo !== w.regUpKo);
        const capPolyMap = (parsedPlaces || name) && hasSubZones ? await getCapPolygonMap(isHard) : new Map();
        const cacheCtrl = bypassNow ? 'no-store' : (isStale ? 'public, max-age=30, s-maxage=30' : 'public, max-age=55, s-maxage=90');

        if (parsedPlaces) {
          const items = {};
          for (const p of parsedPlaces) {
            items[p.key] = {
              name: p.name,
              warnings: sortWarnings(all.filter(w => warningMatchesPlace(w, p.name, p.lat, p.lon, capPolyMap)))
            };
          }
          const res = jsonResponse(
            request,
            env,
            200,
            { ok: true, mode: 'batch', warningsConfirmed: Boolean(getServiceKey(env)) && !isStale, updatedAt: new Date().toISOString(), stale: isStale, items, totalNational: all.length },
            { 'Cache-Control': cacheCtrl }
          );
          if (!isStale && !bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
          return res;
        }

        const matched = name
          ? all.filter(w => warningMatchesPlace(w, name, lat, lon, capPolyMap))
          : all;
        const res = jsonResponse(
          request,
          env,
          200,
          { ok: true, updatedAt: new Date().toISOString(), stale: isStale, warnings: sortWarnings(matched), totalNational: all.length },
          { 'Cache-Control': cacheCtrl }
        );
        if (!isStale && !bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/open-meteo') {
      const endpoint = requestUrl.searchParams.get('endpoint') === 'ensemble' ? 'ensemble' : 'forecast';
      const upstream = new URL(endpoint === 'ensemble' ? 'https://ensemble-api.open-meteo.com/v1/ensemble' : 'https://api.open-meteo.com/v1/forecast');
      for (const [k, v] of requestUrl.searchParams.entries()) {
        if (k !== 'endpoint' && k !== 'force' && k !== 'hard' && k !== 'refresh' && k !== 't') {
          upstream.searchParams.set(k, v);
        }
      }
      const cacheKey = `om|${upstream.toString()}`;
      const maxAge = endpoint === 'ensemble' ? 1800 : 180;
      const ttlMs = endpoint === 'ensemble' ? 30 * 60000 : 4 * 60000;
      const hit = !bypassNow ? getCached(cacheKey) : null;
      if (hit) {
        return jsonResponse(request, env, 200, hit, { 'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}` });
      }
      try {
        const data = await withInFlight(bypassNow ? `${cacheKey}|bypass` : cacheKey, async () => {
          const r = await fetchWithTimeout(upstream.toString(), {}, 12000);
          if (r.status === 429) {
            const err = new Error('Open-Meteo 요청 한도 초과(429)');
            err.status = 429;
            throw err;
          }
          if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
          const parsed = await r.json();
          setCached(cacheKey, parsed, ttlMs);
          return parsed;
        });
        const res = jsonResponse(request, env, 200, data, {
          'Cache-Control': bypassNow ? 'no-store' : `public, max-age=${maxAge}, s-maxage=${maxAge}`
        });
        if (!bypassNow) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, e?.status === 429 ? 429 : 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/search') {
      const q = (requestUrl.searchParams.get('name') || '').trim();
      if (!q) return jsonResponse(request, env, 200, { results: [] });
      const cacheKey = `search|${q}`;
      const hit = getCached(cacheKey);
      if (hit) return jsonResponse(request, env, 200, hit, { 'Cache-Control': 'public, max-age=1800, s-maxage=1800' });
      try {
        const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
        u.searchParams.set('name', q);
        u.searchParams.set('count', '12');
        u.searchParams.set('language', 'ko');
        u.searchParams.set('format', 'json');
        const r = await fetchWithTimeout(u.toString(), {}, 7000);
        const data = r.ok ? await r.json() : { results: [] };
        setCached(cacheKey, data, 30 * 60000);
        const res = jsonResponse(request, env, 200, data, { 'Cache-Control': 'public, max-age=1800, s-maxage=1800' });
        putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch {
        return jsonResponse(request, env, 200, { results: [] });
      }
    }

    if (pathname === '/api/radar') {
      if (!getRadarKey(env)) {
        return jsonResponse(request, env, 503, { code: 'RADAR_KEY_MISSING', error: '레이더 API 키가 설정되지 않았습니다.' });
      }
      const radarForce = bypassNow || requestUrl.searchParams.has('t') && isHard;
      try {
        const x = await radarImage(env, radarForce);
        const headers = buildCorsHeaders(request, env);
        headers.set('Content-Type', x.type);
        headers.set('Cache-Control', radarForce ? 'no-store' : 'public, max-age=240, s-maxage=240');
        const res = new Response(request.method === 'HEAD' ? null : x.bytes, { status: 200, headers });
        if (!radarForce) putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    return jsonResponse(request, env, 404, { error: 'API를 찾지 못했습니다.' });
  }
};
