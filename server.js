/**
 * 비온다? × 날씨봇 (RainWatch & RoadWeather Monitor Korea) — zero-dependency Node.js server.
 * Secrets are ONLY read from environment variables, never sent to the browser.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const core = require('./lib/bionda-core');
const {
  CCTV_CACHE_TTL_SECONDS,
  buildCctvPayload,
  isCctvConfigured
} = require('./lib/cctv-its');

const {
  DATA_GO_KR_BASE,
  APIHUB_FCST_BASE,
  pad,
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
  grouped,
  analyze,
  buildForecastResult,
  parseKmaForecastJson,
  parseRoadStations,
  matchRoadStation,
  parseNcstValues,
  mergeObservationResult,
  parseWrnNow,
  sortWarnings,
  inPolygon,
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
  parseOverviewPlacesParam,
  canonicalOverviewPlacesKey
} = core;

// Load local .env if present and not already loaded
try {
  const envPath = path.join(__dirname, '.env');
  if (fsSync.existsSync(envPath)) {
    const lines = fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        if (k && v && !process.env[k]) process.env[k] = v;
      }
    }
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const ROAD_LINE_CODE = core.getRoadLineCode(process.env);
const getServiceKey = () => core.getServiceKey(process.env);
const getRadarKey = () => core.getRadarKey(process.env);
const getRoadKey = () => core.getRoadKey(process.env);

const SHARED_CACHE = new Map();
const INFLIGHT = new Map();
const REQUESTS = new Map();

function getCached(key) {
  const item = SHARED_CACHE.get(key);
  return item && item.expires > Date.now() ? item.value : null;
}
function setCached(key, value, ms) {
  if (SHARED_CACHE.size > 600) {
    for (const [k, v] of SHARED_CACHE) if (v.expires <= Date.now()) SHARED_CACHE.delete(k);
    if (SHARED_CACHE.size > 600) SHARED_CACHE.delete(SHARED_CACHE.keys().next().value);
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
function getClientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}
function allow(ip) {
  const now = Date.now();
  const hit = REQUESTS.get(ip) || { t: now, n: 0 };
  if (now - hit.t > 60000) { hit.n = 0; hit.t = now; }
  hit.n++;
  REQUESTS.set(ip, hit);
  if (REQUESTS.size > 5000) REQUESTS.clear();
  return hit.n <= 180;
}
function applyApiCors(req, res) {
  const allowList = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const reqOrigin = req.headers.origin;
  if (!allowList.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && allowList.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}
function sendJson(res, code, value, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(value));
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
  u.searchParams.set('nx', grid.nx);
  u.searchParams.set('ny', grid.ny);
  const r = await fetch(u, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json' } });
  if (!r.ok) {
    const err = new Error(`기상청 응답 오류 HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return parseKmaForecastJson(await r.text());
}

async function fetchKma(resource, grid, base, timeout = 5000, bypassCache = false) {
  const apiKey = getServiceKey();
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
        setCached(staleKey, { items, base: isoKst(base) }, staleTtlMs);
        return items;
      } catch (e) {
        lastErr = e;
        if (isApiHubKey && baseUrl.includes('data.go.kr') && (e?.status === 401 || e?.status === 403 || /HTTP 40[13]/.test(errMessage(e)))) {
          setCached('skip-host|data.go.kr', true, 60 * 60000);
        }
      }
    }
    throw lastErr;
  });
}

async function fetchWithFallback(resource, grid, base, prevMinutes, bypassCache = false) {
  try { return { items: await fetchKma(resource, grid, base, 5000, bypassCache), base: isoKst(base) }; }
  catch (error) {
    const previous = new Date(base.getTime() - prevMinutes * 60000);
    try { return { items: await fetchKma(resource, grid, previous, 5000, bypassCache), base: isoKst(previous), notice: '최신 발표분을 가져오지 못해 직전 발표분 사용' }; }
    catch {
      const stale = getCached(`kma-stale|${resource}|${grid.nx}|${grid.ny}`);
      if (stale?.items?.length) {
        return { items: stale.items, base: stale.base, notice: '기상청 일시 지연으로 직전 수신 자료 사용', stale: true };
      }
      throw error;
    }
  }
}

async function forecast(lat, lon) {
  const grid = latlonToGrid(lat, lon);
  if (grid.nx < 1 || grid.nx > 149 || grid.ny < 1 || grid.ny > 253) throw new Error('기상청 예보격자 범위를 벗어난 좌표입니다.');
  const now = Date.now();
  const requests = await Promise.allSettled([
    fetchWithFallback('getUltraSrtFcst', grid, baseUltra(now), 60),
    fetchWithFallback('getVilageFcst', grid, baseShort(now), 180),
    fetchWithFallback('getUltraSrtNcst', grid, baseObservation(now), 60)
  ]);
  return buildForecastResult(grid, now, requests);
}

async function fetchShortTerm12(optionsOrForce = false) {
  if (!getServiceKey()) throw new Error('KMA_SERVICE_KEY 미설정');
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
          probePromise = fetchWithFallback('getUltraSrtFcst', grid, uBase, 60, refreshUltra).then(res => {
            resolvedUBase = res.notice ? new Date(uBase.getTime() - 60 * 60000) : uBase;
            return { firstKey: `${grid.nx},${grid.ny}`, res };
          });
        }
        const probed = await probePromise;
        if (probed.firstKey === `${grid.nx},${grid.ny}`) return probed.res;
      }
      const activeBase = resolvedUBase || uBase;
      return { items: await fetchKma('getUltraSrtFcst', grid, activeBase, 6000, refreshUltra), base: isoKst(activeBase) };
    };

    const payload = await collectShortTerm12({
      now,
      fetchShort: (grid) => fetchWithFallback('getVilageFcst', grid, sBase, 180, refreshShort),
      fetchUltra: fetchUltraSmart
    });
    const pendingUltra = resolvedUBase && resolvedUBase.getTime() < uBase.getTime();
    setCached(cacheKey, payload, pendingUltra ? 45000 : 5 * 60000);
    return payload;
  });
}

async function fetchRoadStations(line = ROAD_LINE_CODE) {
  const key = getRoadKey();
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
        const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const text = new TextDecoder('euc-kr').decode(buf);
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
      } catch {}
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

async function fetchRoadRisk(roadNum = '012') {
  const key = getRoadKey();
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
        const r = await fetch(u, { signal: AbortSignal.timeout(6500) });
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
      } catch {}
    }
    const stale = getCached(staleKey);
    if (stale) return stale;
    throw new Error('도로 위험기상정보(FRG/FOG) ZIP 자료를 가져오지 못했습니다.');
  });
}

async function getObservationForPlace(lat, lon) {
  const cacheKey = `obs|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  let roadMatch = null;
  try {
    const roadData = await fetchRoadStations(ROAD_LINE_CODE);
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
        ? await fetchWithFallback('getUltraSrtNcst', grid, ncstBase, 60)
        : null;
    kmaNcst = parseNcstValues(res, grid);
  } catch {}

  const out = mergeObservationResult(roadMatch, kmaNcst);
  setCached(cacheKey, out, 90000);
  return out;
}

async function fetchOverviewBundle({ placesParam = '', line = ROAD_LINE_CODE, roadNum = '012', force = false } = {}) {
  const places = parseOverviewPlacesParam(placesParam);
  if (!places.length) throw new Error('조회할 유효한 국내 좌표가 없습니다.');
  const now = Date.now();
  const sBase = baseShort(now);
  const uBase = baseUltra(now);
  const oBase = baseObservation(now);
  const bundleKey = `bundle|${line}|${roadNum}|${canonicalOverviewPlacesKey(places)}|${timePart(uBase)}|${timePart(sBase)}`;
  const hit = !force ? getCached(bundleKey) : null;
  if (hit) return hit;

  return withInFlight(force ? `${bundleKey}|force` : bundleKey, async () => {
    const [roadSettled, riskSettled, wrnSettled] = await Promise.allSettled([
      getRoadKey() ? fetchRoadStations(line) : Promise.resolve(null),
      getRoadKey() ? fetchRoadRisk(roadNum) : Promise.resolve(null),
      fetchWrnNowList()
    ]);
    const roadData = roadSettled.status === 'fulfilled' ? roadSettled.value : null;
    const roadRisk = riskSettled.status === 'fulfilled' ? riskSettled.value : null;
    const allWarnings = wrnSettled.status === 'fulfilled' ? wrnSettled.value : [];
    const hasSubZones = allWarnings.some(w => w.regUpKo && w.regKo !== w.regUpKo);
    const capPolyMap = hasSubZones ? await getCapPolygonMap() : new Map();

    // 각 지점별 도로관측 매칭 먼저 계산 후, 관측 결측 지점의 고유 격자만 getUltraSrtNcst 추가 조회
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
    if (getServiceKey()) {
      let resolvedUBase = null;
      let ultraProbePromise = null;
      const fetchBundleUltra = async (grid) => {
        if (!resolvedUBase) {
          if (!ultraProbePromise) {
            ultraProbePromise = fetchWithFallback('getUltraSrtFcst', grid, uBase, 60).then(res => {
              resolvedUBase = res.notice ? new Date(uBase.getTime() - 60 * 60000) : uBase;
              return { firstKey: `${grid.nx},${grid.ny}`, res };
            });
          }
          const probed = await ultraProbePromise;
          if (probed.firstKey === `${grid.nx},${grid.ny}`) return probed.res;
        }
        const activeBase = resolvedUBase || uBase;
        return { items: await fetchKma('getUltraSrtFcst', grid, activeBase, 6000), base: isoKst(activeBase) };
      };

      await Promise.allSettled(gridEntries.map(async ([gk, grid]) => {
        const requests = await Promise.allSettled([
          fetchBundleUltra(grid),
          fetchWithFallback('getVilageFcst', grid, sBase, 180),
          gridNeedsNcst.has(gk) ? fetchWithFallback('getUltraSrtNcst', grid, oBase, 60) : Promise.resolve(null)
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

async function fetchWrnNowList() {
  const key = getServiceKey();
  if (!key) return [];
  const cacheKey = 'kma-wrn-now';
  const staleKey = 'kma-wrn-now-last-good';
  const hit = getCached(cacheKey);
  if (hit) return hit;
  return withInFlight(cacheKey, async () => {
    try {
      const u = new URL('https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php');
      u.searchParams.set('fe', 'f');
      u.searchParams.set('tm', '');
      u.searchParams.set('disp', '0');
      u.searchParams.set('help', '2');
      u.searchParams.set('authKey', deEncodedKey(key));
      const r = await fetch(u, { signal: AbortSignal.timeout(6500) });
      if (!r.ok) throw new Error(`KMA 특보 응답 오류 HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const text = new TextDecoder('euc-kr').decode(buf);
      const parsed = parseWrnNow(text);
      setCached(cacheKey, parsed, 90000);
      setCached(staleKey, parsed, 20 * 60000);
      return parsed;
    } catch (e) {
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

async function fetchCapXml(file = '') {
  const cleanFile = String(file || '').trim();
  if (cleanFile && !/^KR\.W\d+_\d{12}_[A-Z]{2,6}_\d+_(EN|KR)\.xml$/.test(cleanFile)) {
    throw new Error('유효하지 않은 CAP XML 파일명입니다.');
  }
  const cacheKey = `cap|${cleanFile || 'rss'}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;
  const targetUrl = cleanFile
    ? `https://www.weather.go.kr/w/repositary/xml/wrn/xml/${cleanFile}`
    : 'https://www.weather.go.kr/w/rss/cap/warning.do';
  const r = await fetch(targetUrl, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`기상청 CAP 응답 오류 HTTP ${r.status}`);
  const xml = await r.text();
  setCached(cacheKey, xml, cleanFile ? 30 * 60000 : 60000);
  return xml;
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

async function radarImage() {
  const radarKey = getRadarKey();
  if (!radarKey) throw new Error('KMA_RADAR_KEY 미설정');
  const cache = getCached('radar-visual');
  if (cache) return cache;
  const u = new URL('https://apihub.kma.go.kr/api/typ03/cgi/rdr/nph-rdr_cmp1_img');
  const p = { cmp: 'HSR', qcd: 'HSLP', obs: 'ECHD', color: 'C4', aws: '0', map: 'HR', grid: '2', legend: '1', size: '800', itv: '5', zoom_level: '0', zoom_x: '0000000', zoom_y: '0000000', gov: '', authKey: deEncodedKey(radarKey) };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`레이더 서버 오류 HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const type = detectRadarImageType(bytes);
  const out = { buf: Buffer.from(bytes), type };
  setCached('radar-visual', out, 4 * 60000);
  return out;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};

async function serve(req, res, pathname) {
  const safe = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC, '.' + decodeURIComponent(safe));
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: '접근할 수 없습니다.' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': safe === '/index.html' || safe === '/hourly.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    sendJson(res, 404, { error: '파일을 찾지 못했습니다.' });
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https://*.weather.go.kr; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; media-src 'self' blob: https: http:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; frame-src https://embed.windy.com https://*.windy.com https://www.roadplus.co.kr https://*.roadplus.co.kr; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  if (req.method === 'OPTIONS') {
    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname.startsWith('/api/')) {
      applyApiCors(req, res);
      res.writeHead(204);
      return res.end();
    }
    return sendJson(res, 405, { error: '허용되지 않는 요청' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '허용되지 않는 요청' });
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = requestUrl.pathname;

  if (pathname.startsWith('/api/') && !/\.(?:json|png|jpe?g|webp|svg|txt)$/i.test(pathname)) {
    applyApiCors(req, res);
    const ip = getClientIp(req);
    if (!allow(ip)) return sendJson(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 이용해 주세요.' });

    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        status: 'ok',
        forecastConfigured: !!getServiceKey(),
        radarConfigured: !!getRadarKey(),
        roadConfigured: !!getRoadKey(),
        cctvConfigured: isCctvConfigured(process.env),
        roadLine: ROAD_LINE_CODE
      });
    }

    if (pathname === '/api/cctv') {
      const refresh = requestUrl.searchParams.get('refresh') === '1' || requestUrl.searchParams.get('refresh') === 'true';
      const cacheKey = 'its-cctv-corridor';
      if (!refresh) {
        const hit = getCached(cacheKey);
        if (hit) {
          return sendJson(res, 200, { ...hit, cache: 'HIT' }, {
            'X-Cache': 'HIT',
            'Cache-Control': `public, max-age=${CCTV_CACHE_TTL_SECONDS}`
          });
        }
      }
      try {
        const payload = refresh
          ? await buildCctvPayload(process.env)
          : await withInFlight(cacheKey, () => buildCctvPayload(process.env));
        setCached(cacheKey, payload, CCTV_CACHE_TTL_SECONDS * 1000);
        const mode = refresh ? 'REFRESH' : 'MISS';
        return sendJson(res, 200, { ...payload, cache: mode }, {
          'X-Cache': mode,
          'Cache-Control': `public, max-age=${CCTV_CACHE_TTL_SECONDS}`
        });
      } catch (err) {
        const code = (err && err.code) || 'UNKNOWN_ERROR';
        const status = code === 'ITS_API_KEY_MISSING' ? 500 : 502;
        return sendJson(res, status, {
          ok: false,
          error: code,
          message: (err && err.message) || '알 수 없는 오류',
          detail: (err && err.detail) || null,
          hint:
            code === 'ITS_API_KEY_MISSING'
              ? '환경변수 ITS_API_KEY를 설정한 뒤 다시 호출하세요. (README_cctv.md 참고)'
              : '9443 포트가 막히는 경우 CCTV_SOURCE_URL 환경변수를 지정하세요. (README_cctv.md 참고)',
          at: new Date().toISOString()
        }, { 'X-Cache': 'BYPASS' });
      }
    }

    if (pathname === '/api/forecast') {
      const lat = Number(requestUrl.searchParams.get('lat')), lon = Number(requestUrl.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 32 || lat > 39.5 || lon < 124 || lon > 132) {
        return sendJson(res, 400, { error: '유효한 국내 위도·경도를 입력해 주세요.' });
      }
      if (!getServiceKey()) return sendJson(res, 503, { code: 'KEY_MISSING', error: '운영자가 기상청 예보 API 키를 등록하지 않았습니다.' });
      try {
        const value = await forecast(lat, lon);
        return sendJson(res, 200, value, { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' });
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/overview-bundle') {
      if (!getServiceKey() && !getRoadKey()) return sendJson(res, 503, { code: 'KEY_MISSING', error: '운영자가 기상청 API 키를 등록하지 않았습니다.' });
      try {
        const isForced = requestUrl.searchParams.get('force') === '1';
        const line = requestUrl.searchParams.get('line') || ROAD_LINE_CODE;
        const roadNum = requestUrl.searchParams.get('roadNum') || '012';
        const placesParam = requestUrl.searchParams.get('places') || '';
        const value = await fetchOverviewBundle({ placesParam, line, roadNum, force: isForced });
        return sendJson(res, 200, value, {
          'Cache-Control': isForced ? 'no-store' : 'public, max-age=60, s-maxage=90'
        });
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/short-term-12') {
      if (!getServiceKey()) return sendJson(res, 503, { code: 'KEY_MISSING', error: '운영자가 기상청 예보 API 키를 등록하지 않았습니다.' });
      try {
        const isForced = requestUrl.searchParams.get('force') === '1';
        const rsParam = requestUrl.searchParams.get('refreshShort');
        const ruParam = requestUrl.searchParams.get('refreshUltra');
        const refreshShort = rsParam !== null ? rsParam === '1' : isForced;
        const refreshUltra = ruParam !== null ? ruParam === '1' : isForced;
        const value = await fetchShortTerm12({ force: isForced, refreshShort, refreshUltra });
        const nowMs = Date.now();
        const kstMin = kst(nowMs).getUTCMinutes();
        const secsToHour = Math.max(5, Math.ceil((3600000 - (nowMs % 3600000)) / 1000));
        const minsPast35 = kstMin < 35 ? (35 - kstMin) * 60 : 3600;
        const expectedUltraIso = isoKst(baseUltra(nowMs));
        const pendingUltraRelease = value?.sources?.ultraBase && Date.parse(value.sources.ultraBase) < Date.parse(expectedUltraIso);
        const capSec = pendingUltraRelease ? 45 : 300;
        const maxAge = Math.min(180, secsToHour, minsPast35, capSec);
        const sMaxAge = Math.min(300, secsToHour, minsPast35, capSec);
        const bypassAllCache = isForced || refreshShort || refreshUltra;
        return sendJson(res, 200, value, {
          'Cache-Control': bypassAllCache ? 'no-store' : `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=60`
        });
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/road-obs') {
      if (!getRoadKey()) return sendJson(res, 503, { code: 'ROAD_KEY_MISSING', error: '도로기상관측 API 키가 설정되지 않았습니다.' });
      const line = requestUrl.searchParams.get('line') || ROAD_LINE_CODE;
      try {
        const value = await fetchRoadStations(line);
        return sendJson(res, 200, value, { 'Cache-Control': 'public, max-age=60' });
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/road-risk') {
      if (!getRoadKey()) return sendJson(res, 503, { code: 'ROAD_KEY_MISSING', error: '도로 위험기상정보 API 키가 설정되지 않았습니다.' });
      const roadNum = requestUrl.searchParams.get('roadNum') || '012';
      try {
        const value = await fetchRoadRisk(roadNum);
        const latRaw = requestUrl.searchParams.get('lat');
        const lonRaw = requestUrl.searchParams.get('lon');
        if (latRaw !== null && lonRaw !== null) {
          const lat = Number(latRaw), lon = Number(lonRaw);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const customMatch = matchStationRiskForCoord(lat, lon, value.stationRisks, null, null, 6);
            return sendJson(res, 200, { ...value, customPlaceRisk: customMatch }, { 'Cache-Control': 'public, max-age=480, s-maxage=540' });
          }
        }
        return sendJson(res, 200, value, { 'Cache-Control': 'public, max-age=480, s-maxage=540' });
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/observation') {
      const lat = Number(requestUrl.searchParams.get('lat')), lon = Number(requestUrl.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 32 || lat > 39.5 || lon < 124 || lon > 132) {
        return sendJson(res, 400, { error: '유효한 국내 위도·경도를 입력해 주세요.' });
      }
      try {
        const obs = await getObservationForPlace(lat, lon);
        return sendJson(res, 200, obs, { 'Cache-Control': 'public, max-age=60' });
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/kma-cap') {
      const file = requestUrl.searchParams.get('file') || '';
      try {
        const xml = await fetchCapXml(file);
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
        return res.end(xml);
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
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
          return sendJson(res, 400, { error: '조회할 유효한 국내 좌표가 없습니다.' });
        }
        const all = await fetchWrnNowList();
        const isStale = Boolean(all._stale);
        const hasSubZones = all.some(w => w.regUpKo && w.regKo !== w.regUpKo);
        const capPolyMap = (parsedPlaces || name) && hasSubZones ? await getCapPolygonMap() : new Map();
        const cacheCtrl = isStale ? 'public, max-age=30, s-maxage=30' : 'public, max-age=55, s-maxage=90';
        if (parsedPlaces) {
          const items = {};
          for (const p of parsedPlaces) {
            items[p.key] = {
              name: p.name,
              warnings: sortWarnings(all.filter(w => warningMatchesPlace(w, p.name, p.lat, p.lon, capPolyMap)))
            };
          }
          return sendJson(res, 200, { ok: true, mode: 'batch', updatedAt: new Date().toISOString(), stale: isStale, items, totalNational: all.length }, { 'Cache-Control': cacheCtrl });
        }
        const matched = name
          ? all.filter(w => warningMatchesPlace(w, name, lat, lon, capPolyMap))
          : all;
        return sendJson(res, 200, { ok: true, updatedAt: new Date().toISOString(), stale: isStale, warnings: sortWarnings(matched), totalNational: all.length }, { 'Cache-Control': cacheCtrl });
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
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
      if (hit) return sendJson(res, 200, hit, { 'Cache-Control': `public, max-age=${maxAge}` });
      try {
        const data = await withInFlight(cacheKey, async () => {
          const r = await fetch(upstream, { signal: AbortSignal.timeout(12000) });
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
        return sendJson(res, 200, data, { 'Cache-Control': `public, max-age=${maxAge}` });
      } catch (e) {
        return sendJson(res, e?.status === 429 ? 429 : 502, { error: errMessage(e) });
      }
    }

    if (pathname === '/api/search') {
      const q = (requestUrl.searchParams.get('name') || '').trim();
      if (!q) return sendJson(res, 200, { results: [] });
      const cacheKey = `search|${q}`;
      const hit = getCached(cacheKey);
      if (hit) return sendJson(res, 200, hit);
      try {
        const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
        u.searchParams.set('name', q);
        u.searchParams.set('count', '12');
        u.searchParams.set('language', 'ko');
        u.searchParams.set('format', 'json');
        const r = await fetch(u, { signal: AbortSignal.timeout(7000) });
        const data = r.ok ? await r.json() : { results: [] };
        setCached(cacheKey, data, 30 * 60000);
        return sendJson(res, 200, data);
      } catch {
        return sendJson(res, 200, { results: [] });
      }
    }

    if (pathname === '/api/radar') {
      if (!getRadarKey()) return sendJson(res, 503, { code: 'RADAR_KEY_MISSING', error: '레이더 API 키가 설정되지 않았습니다.' });
      try {
        const x = await radarImage();
        res.writeHead(200, { 'Content-Type': x.type, 'Cache-Control': 'public,max-age=240,s-maxage=240' });
        return res.end(x.buf);
      } catch (e) {
        return sendJson(res, 502, { error: errMessage(e) });
      }
    }

    return sendJson(res, 404, { error: 'API를 찾지 못했습니다.' });
  }
  return serve(req, res, pathname);
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`RainWatch & RoadWeather Monitor Korea http://localhost:${PORT}`));
module.exports = {
  latlonToGrid,
  baseUltra,
  baseShort,
  baseObservation,
  analyze,
  grouped,
  forecast,
  fetchShortTerm12,
  getObservationForPlace,
  fetchRoadRisk,
  parseRoadStations,
  matchRoadStation,
  parseWrnNow,
  sortWarnings,
  inPolygon,
  warningMatchesPlace,
  server
};
