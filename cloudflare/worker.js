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
  parseRoadRiskCsv,
  buildRoadRiskPayload,
  matchStationRiskForCoord,
  collectShortTerm12,
  parseOverviewPlacesParam
} from '../lib/bionda-core.js';

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

function withInFlight(key, loader) {
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = Promise.resolve().then(loader).finally(() => {
    INFLIGHT.delete(key);
  });
  INFLIGHT.set(key, p);
  return p;
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

function buildCorsHeaders(request, env = {}) {
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
  if (!r.ok) throw new Error(`기상청 응답 오류 HTTP ${r.status}`);
  return parseKmaForecastJson(await r.text());
}

async function fetchKma(env, resource, grid, base, timeout = 5000) {
  const apiKey = getServiceKey(env);
  if (!apiKey) throw new Error('KMA_SERVICE_KEY 미설정');
  const cacheKey = `kma|${resource}|${grid.nx}|${grid.ny}|${datePart(base)}|${timePart(base)}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  return withInFlight(cacheKey, async () => {
    const isApiHubKey = /^[A-Za-z0-9_-]{20,26}$/.test(apiKey.trim()) && !apiKey.includes('dummy');
    const bases = isApiHubKey
      ? [APIHUB_FCST_BASE, DATA_GO_KR_BASE]
      : [DATA_GO_KR_BASE, APIHUB_FCST_BASE];

    let lastErr;
    for (const baseUrl of bases) {
      try {
        const items = await fetchKmaFromBase(baseUrl, resource, grid, base, apiKey, timeout);
        const ttlMs = resource === 'getVilageFcst' ? 45 * 60000 : 5 * 60000;
        setCached(cacheKey, items, ttlMs);
        return items;
      } catch (e) {
        lastErr = e;
        console.warn('[fetchKma]', resource, baseUrl.includes('apihub') ? 'apihub' : 'data.go.kr', grid.nx, grid.ny, errMessage(e));
      }
    }
    throw lastErr;
  });
}

async function fetchWithFallback(env, resource, grid, base, prevMinutes) {
  try {
    return { items: await fetchKma(env, resource, grid, base), base: isoKst(base) };
  } catch (error) {
    const previous = new Date(base.getTime() - prevMinutes * 60000);
    try {
      return {
        items: await fetchKma(env, resource, grid, previous),
        base: isoKst(previous),
        notice: '최신 발표분을 가져오지 못해 직전 발표분 사용'
      };
    } catch {
      throw error;
    }
  }
}

async function forecast(env, lat, lon) {
  const grid = latlonToGrid(lat, lon);
  if (grid.nx < 1 || grid.nx > 149 || grid.ny < 1 || grid.ny > 253) {
    throw new Error('기상청 예보격자 범위를 벗어난 좌표입니다.');
  }
  const now = Date.now();
  const requests = await Promise.allSettled([
    fetchWithFallback(env, 'getUltraSrtFcst', grid, baseUltra(now), 60),
    fetchWithFallback(env, 'getVilageFcst', grid, baseShort(now), 180),
    fetchWithFallback(env, 'getUltraSrtNcst', grid, baseObservation(now), 60)
  ]);
  return buildForecastResult(grid, now, requests);
}

async function fetchShortTerm12(env, force = false) {
  const apiKey = getServiceKey(env);
  if (!apiKey) throw new Error('KMA_SERVICE_KEY 미설정');
  const now = Date.now();
  const sBase = baseShort(now);
  const uBase = baseUltra(now);
  const cacheKey = `short12|${datePart(sBase)}|${timePart(sBase)}|${timePart(uBase)}`;
  const hit = !force ? getCached(cacheKey) : null;
  if (hit) return hit;

  return withInFlight(force ? `${cacheKey}|force` : cacheKey, async () => {
    let resolvedUBase = null;
    let probePromise = null;
    const fetchUltraSmart = async (grid) => {
      if (!resolvedUBase) {
        if (!probePromise) {
          probePromise = fetchWithFallback(env, 'getUltraSrtFcst', grid, uBase, 60).then(res => {
            resolvedUBase = res.notice ? new Date(uBase.getTime() - 60 * 60000) : uBase;
            return { firstKey: `${grid.nx},${grid.ny}`, res };
          });
        }
        const probed = await probePromise;
        if (probed.firstKey === `${grid.nx},${grid.ny}`) return probed.res;
      }
      const activeBase = resolvedUBase || uBase;
      return { items: await fetchKma(env, 'getUltraSrtFcst', grid, activeBase, 6000), base: isoKst(activeBase) };
    };

    const payload = await collectShortTerm12({
      now,
      fetchShort: (grid) => fetchWithFallback(env, 'getVilageFcst', grid, sBase, 180),
      fetchUltra: fetchUltraSmart
    });
    setCached(cacheKey, payload, 5 * 60000);
    return payload;
  });
}

async function fetchRoadStations(env, line = getRoadLineCode(env)) {
  const key = getRoadKey(env);
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const cacheKey = `road-obs|${line}`;
  const staleKey = `road-obs-last-good|${line}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  return withInFlight(cacheKey, async () => {
    const now = Date.now();
    const offsetsMinutes = [2, 5, 9];
    let lastStations = [];
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
        const r = await fetchWithTimeout(u.toString(), {}, 5000);
        if (!r.ok) {
          console.warn('[fetchRoadStations] HTTP', r.status, tm1);
          continue;
        }
        const bytes = new Uint8Array(await r.arrayBuffer());
        const text = new TextDecoder('euc-kr').decode(bytes);
        const parsed = parseRoadStations(text);
        if (parsed.length) {
          lastStations = parsed;
          if (parsed.some(s => s.temp !== null || s.roadTemp !== null)) {
            const result = { ok: true, line: String(line), tm1, updatedAt: new Date().toISOString(), stations: parsed };
            setCached(cacheKey, result, 2 * 60000);
            setCached(staleKey, result, 20 * 60000);
            return result;
          }
        }
      } catch (e) {
        console.warn('[fetchRoadStations] err off=' + off, errMessage(e));
      }
    }
    if (lastStations.length) {
      const result = { ok: true, line: String(line), updatedAt: new Date().toISOString(), stations: lastStations };
      setCached(cacheKey, result, 60000);
      return result;
    }
    const stale = getCached(staleKey);
    if (stale) return stale;
    throw new Error('도로기상관측 자료를 가져오지 못했습니다.');
  });
}

async function fetchRoadRisk(env, roadNum = '012') {
  const key = getRoadKey(env);
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const cleanNum = String(roadNum || '012').replace(/\D/g, '').padStart(3, '0').slice(-3);
  const cacheKey = `road-risk|${cleanNum}`;
  const staleKey = `road-risk-last-good|${cleanNum}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  return withInFlight(cacheKey, async () => {
    const now = Date.now();
    const offsetsMinutes = [5, 10, 15, 20];
    for (const off of offsetsMinutes) {
      try {
        const { tmUtc, tmKst } = utcFiveMinSlot(now - off * 60000);
        const u = new URL('https://apihub.kma.go.kr/api/typ04/url/road_file_down.php');
        u.searchParams.set('tm', tmUtc);
        u.searchParams.set('roadNum', cleanNum);
        u.searchParams.set('authKey', deEncodedKey(key));
        const r = await fetchWithTimeout(u.toString(), {}, 6500);
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
        const payload = buildRoadRiskPayload({ roadNum: cleanNum, tmUtc, tmKst, frgRows, fogRows });
        setCached(cacheKey, payload, 9 * 60000);
        setCached(staleKey, payload, 25 * 60000);
        return payload;
      } catch (e) {
        console.warn('[fetchRoadRisk] err off=' + off, errMessage(e));
      }
    }
    const stale = getCached(staleKey);
    if (stale) return stale;
    throw new Error('도로 위험기상정보(FRG/FOG) ZIP 자료를 가져오지 못했습니다.');
  });
}

async function getObservationForPlace(env, lat, lon) {
  const cacheKey = `obs|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  let roadMatch = null;
  try {
    const roadData = await fetchRoadStations(env, getRoadLineCode(env));
    const m = matchRoadStation(lat, lon, roadData.stations);
    if (m && m.distanceKm <= 28) roadMatch = m;
  } catch {}

  let kmaNcst = null;
  const needsNcstFallback = !roadMatch || roadMatch.temp === null || roadMatch.humidity === null;
  try {
    const grid = latlonToGrid(lat, lon);
    const ncstBase = baseObservation(Date.now());
    const cachedNcstItems = getCached(`kma|getUltraSrtNcst|${grid.nx}|${grid.ny}|${datePart(ncstBase)}|${timePart(ncstBase)}`);
    const res = cachedNcstItems
      ? { items: cachedNcstItems, base: isoKst(ncstBase) }
      : needsNcstFallback
        ? await fetchWithFallback(env, 'getUltraSrtNcst', grid, ncstBase, 60)
        : null;
    kmaNcst = parseNcstValues(res, grid);
  } catch {}

  const out = mergeObservationResult(roadMatch, kmaNcst);
  setCached(cacheKey, out, 90000);
  return out;
}

async function fetchOverviewBundle(env, { placesParam = '', line = getRoadLineCode(env), roadNum = '012', force = false } = {}) {
  const places = parseOverviewPlacesParam(placesParam);
  if (!places.length) throw new Error('조회할 유효한 국내 좌표가 없습니다.');
  const now = Date.now();
  const sBase = baseShort(now);
  const uBase = baseUltra(now);
  const oBase = baseObservation(now);
  const bundleKey = `bundle|${line}|${roadNum}|${places.map(p => p.key).join('|')}|${timePart(uBase)}|${timePart(sBase)}`;
  const hit = !force ? getCached(bundleKey) : null;
  if (hit) return hit;

  return withInFlight(force ? `${bundleKey}|force` : bundleKey, async () => {
    const [roadSettled, riskSettled, wrnSettled] = await Promise.allSettled([
      getRoadKey(env) ? fetchRoadStations(env, line) : Promise.resolve(null),
      getRoadKey(env) ? fetchRoadRisk(env, roadNum) : Promise.resolve(null),
      fetchWrnNowList(env)
    ]);
    const roadData = roadSettled.status === 'fulfilled' ? roadSettled.value : null;
    const roadRisk = riskSettled.status === 'fulfilled' ? riskSettled.value : null;
    const allWarnings = wrnSettled.status === 'fulfilled' ? wrnSettled.value : [];
    const hasSubZones = allWarnings.some(w => w.regUpKo && w.regKo !== w.regUpKo);
    const capPolyMap = hasSubZones ? await getCapPolygonMap() : new Map();

    const placeRoadMatches = new Map();
    const gridNeedsNcst = new Set();
    const uniqueGrids = new Map();
    for (const p of places) {
      const gk = `${p.grid.nx},${p.grid.ny}`;
      if (!uniqueGrids.has(gk)) uniqueGrids.set(gk, p.grid);
      const rm = roadData?.stations?.length ? matchRoadStation(p.lat, p.lon, roadData.stations) : null;
      const validRm = rm && rm.distanceKm <= 28 ? rm : null;
      placeRoadMatches.set(p.key, validRm);
      if (!validRm || validRm.temp === null || validRm.humidity === null) {
        gridNeedsNcst.add(gk);
      }
    }

    const gridEntries = [...uniqueGrids.entries()];
    const gridResults = new Map();
    if (getServiceKey(env)) {
      let resolvedUBase = null;
      let ultraProbePromise = null;
      const fetchBundleUltra = async (grid) => {
        if (!resolvedUBase) {
          if (!ultraProbePromise) {
            ultraProbePromise = fetchWithFallback(env, 'getUltraSrtFcst', grid, uBase, 60).then(res => {
              resolvedUBase = res.notice ? new Date(uBase.getTime() - 60 * 60000) : uBase;
              return { firstKey: `${grid.nx},${grid.ny}`, res };
            });
          }
          const probed = await ultraProbePromise;
          if (probed.firstKey === `${grid.nx},${grid.ny}`) return probed.res;
        }
        const activeBase = resolvedUBase || uBase;
        return { items: await fetchKma(env, 'getUltraSrtFcst', grid, activeBase, 6000), base: isoKst(activeBase) };
      };

      await Promise.allSettled(gridEntries.map(async ([gk, grid]) => {
        const requests = await Promise.allSettled([
          fetchBundleUltra(grid),
          fetchWithFallback(env, 'getVilageFcst', grid, sBase, 180),
          gridNeedsNcst.has(gk) ? fetchWithFallback(env, 'getUltraSrtNcst', grid, oBase, 60) : Promise.resolve(null)
        ]);
        gridResults.set(gk, requests);
      }));
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
        warnings: matchedWrn
      };
    }

    const payload = {
      ok: true,
      mode: 'overview-bundle',
      updatedAt: new Date(now).toISOString(),
      roadLine: String(line),
      roadStations: roadData?.stations || [],
      roadRisk,
      items
    };
    setCached(bundleKey, payload, 90000);
    return payload;
  });
}

async function fetchWrnNowList(env) {
  const key = getServiceKey(env);
  if (!key) return [];
  const cacheKey = 'kma-wrn-now';
  const hit = getCached(cacheKey);
  if (hit) return hit;
  return withInFlight(cacheKey, async () => {
    const u = new URL('https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php');
    u.searchParams.set('fe', 'f');
    u.searchParams.set('tm', '');
    u.searchParams.set('disp', '0');
    u.searchParams.set('help', '2');
    u.searchParams.set('authKey', deEncodedKey(key));
    const r = await fetchWithTimeout(u.toString(), {}, 9000);
    if (!r.ok) return [];
    const bytes = new Uint8Array(await r.arrayBuffer());
    const text = new TextDecoder('euc-kr').decode(bytes);
    const parsed = parseWrnNow(text);
    setCached(cacheKey, parsed, 60000);
    return parsed;
  });
}

async function fetchCapXml(file = '') {
  const cleanFile = String(file || '').trim();
  if (cleanFile && !/^KR\.W\d+_\d{12}_[A-Z]{2,6}_\d+_(EN|KR)\.xml$/.test(cleanFile)) {
    throw new Error('유효하지 않은 CAP XML 파일명입니다.');
  }
  const cacheKey = `cap|${cleanFile || 'rss'}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;
  return withInFlight(cacheKey, async () => {
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

async function getCapPolygonMap() {
  const cached = getCached('kma-cap-polygons');
  if (cached) return cached;
  const polyMap = new Map();
  try {
    const rssXml = await fetchCapXml('');
    const links = extractCapLinksFromRss(rssXml, 8);
    const docs = await Promise.allSettled(links.map(f => fetchCapXml(f)));
    for (const res of docs) {
      if (res.status === 'fulfilled') populateCapPolygons(res.value, polyMap);
    }
  } catch {}
  setCached('kma-cap-polygons', polyMap, 120000);
  return polyMap;
}

async function radarImage(env) {
  const radarKey = getRadarKey(env);
  if (!radarKey) throw new Error('KMA_RADAR_KEY 미설정');
  const cacheKey = 'radar-visual';
  const cache = getCached(cacheKey);
  if (cache) return cache;
  return withInFlight(cacheKey, async () => {
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

    // Check Edge Cache API (normalized radar key unless force=1)
    const isForced = requestUrl.searchParams.get('force') === '1';
    const cacheKeyReq = edgeCacheRequest(requestUrl, pathname === '/api/radar');
    if (!isForced) {
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
        const value = await forecast(env, lat, lon);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
        });
        putEdgeCache(ctx, cacheKeyReq, res);
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
        const value = await fetchOverviewBundle(env, { placesParam, line, roadNum, force: isForced });
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': isForced ? 'no-store' : 'public, max-age=60, s-maxage=90'
        });
        if (!isForced) putEdgeCache(ctx, cacheKeyReq, res);
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
        const value = await fetchShortTerm12(env, isForced);
        const res = jsonResponse(request, env, 200, value, {
          'Cache-Control': isForced ? 'no-store' : 'public, max-age=180, s-maxage=300, stale-while-revalidate=600'
        });
        if (!isForced) putEdgeCache(ctx, cacheKeyReq, res);
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
        const value = await fetchRoadStations(env, line);
        const res = jsonResponse(request, env, 200, value, { 'Cache-Control': 'public, max-age=60, s-maxage=90' });
        putEdgeCache(ctx, cacheKeyReq, res);
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
        const value = await fetchRoadRisk(env, roadNum);
        const latRaw = requestUrl.searchParams.get('lat');
        const lonRaw = requestUrl.searchParams.get('lon');
        let out = value;
        if (latRaw !== null && lonRaw !== null) {
          const lat = Number(latRaw), lon = Number(lonRaw);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            out = { ...value, customPlaceRisk: matchStationRiskForCoord(lat, lon, value.stationRisks, null, null, 6) };
          }
        }
        const res = jsonResponse(request, env, 200, out, { 'Cache-Control': 'public, max-age=480, s-maxage=540' });
        putEdgeCache(ctx, cacheKeyReq, res);
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
        const obs = await getObservationForPlace(env, lat, lon);
        const res = jsonResponse(request, env, 200, obs, { 'Cache-Control': 'public, max-age=60, s-maxage=90' });
        putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/kma-cap') {
      const file = requestUrl.searchParams.get('file') || '';
      try {
        const xml = await fetchCapXml(file);
        const headers = buildCorsHeaders(request, env);
        headers.set('Content-Type', 'application/xml; charset=utf-8');
        headers.set('Cache-Control', file ? 'public, max-age=1800, s-maxage=1800' : 'public, max-age=60, s-maxage=60');
        const res = new Response(request.method === 'HEAD' ? null : xml, { status: 200, headers });
        putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/warnings') {
      const name = (requestUrl.searchParams.get('name') || '').trim();
      const latRaw = requestUrl.searchParams.get('lat');
      const lonRaw = requestUrl.searchParams.get('lon');
      const lat = latRaw !== null ? Number(latRaw) : NaN;
      const lon = lonRaw !== null ? Number(lonRaw) : NaN;
      try {
        const all = await fetchWrnNowList(env);
        const hasSubZones = all.some(w => w.regUpKo && w.regKo !== w.regUpKo);
        const capPolyMap = name && hasSubZones ? await getCapPolygonMap() : new Map();
        const matched = name
          ? all.filter(w => warningMatchesPlace(w, name, lat, lon, capPolyMap))
          : all;
        const res = jsonResponse(
          request,
          env,
          200,
          { ok: true, updatedAt: new Date().toISOString(), warnings: sortWarnings(matched), totalNational: all.length },
          { 'Cache-Control': 'public, max-age=55, s-maxage=55' }
        );
        putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/open-meteo') {
      const endpoint = requestUrl.searchParams.get('endpoint') === 'ensemble' ? 'ensemble' : 'forecast';
      const upstream = new URL(endpoint === 'ensemble' ? 'https://ensemble-api.open-meteo.com/v1/ensemble' : 'https://api.open-meteo.com/v1/forecast');
      for (const [k, v] of requestUrl.searchParams.entries()) {
        if (k !== 'endpoint') upstream.searchParams.set(k, v);
      }
      const cacheKey = `om|${upstream.toString()}`;
      const maxAge = endpoint === 'ensemble' ? 1800 : 180;
      const ttlMs = endpoint === 'ensemble' ? 30 * 60000 : 4 * 60000;
      const hit = getCached(cacheKey);
      if (hit) {
        return jsonResponse(request, env, 200, hit, { 'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}` });
      }
      try {
        const data = await withInFlight(cacheKey, async () => {
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
        const res = jsonResponse(request, env, 200, data, { 'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}` });
        putEdgeCache(ctx, cacheKeyReq, res);
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
      try {
        const x = await radarImage(env);
        const headers = buildCorsHeaders(request, env);
        headers.set('Content-Type', x.type);
        headers.set('Cache-Control', 'public, max-age=240, s-maxage=240');
        const res = new Response(request.method === 'HEAD' ? null : x.bytes, { status: 200, headers });
        putEdgeCache(ctx, cacheKeyReq, res);
        return res;
      } catch (e) {
        return jsonResponse(request, env, 502, { error: errMessage(e) });
      }
    }

    return jsonResponse(request, env, 404, { error: 'API를 찾지 못했습니다.' });
  }
};
