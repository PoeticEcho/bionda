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
  detectRadarImageType
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
  if (!r.ok) throw new Error(`기상청 응답 오류 HTTP ${r.status}`);
  return parseKmaForecastJson(await r.text());
}

async function fetchKma(resource, grid, base, timeout = 7500) {
  const apiKey = getServiceKey();
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
        setCached(cacheKey, items, 12 * 60000);
        return items;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  });
}

async function fetchWithFallback(resource, grid, base, prevMinutes) {
  try { return { items: await fetchKma(resource, grid, base), base: isoKst(base) }; }
  catch (error) {
    const previous = new Date(base.getTime() - prevMinutes * 60000);
    try { return { items: await fetchKma(resource, grid, previous), base: isoKst(previous), notice: '최신 발표분을 가져오지 못해 직전 발표분 사용' }; }
    catch { throw error; }
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

async function fetchRoadStations(line = ROAD_LINE_CODE) {
  const key = getRoadKey();
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const cacheKey = `road-obs|${line}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  return withInFlight(cacheKey, async () => {
    const now = Date.now();
    const offsetsMinutes = [2, 4, 8];
    let lastStations = [];
    for (const off of offsetsMinutes) {
      const d = kst(now - off * 60000);
      const tm1 = datePart(d) + timePart(d);
      const u = new URL('https://apihub.kma.go.kr/api/typ01/url/road_stn_obs.php');
      u.searchParams.set('mode', '2');
      u.searchParams.set('tm1', tm1);
      u.searchParams.set('var', String(line));
      u.searchParams.set('disp', '1');
      u.searchParams.set('help', '2');
      u.searchParams.set('authKey', deEncodedKey(key));
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const text = new TextDecoder('euc-kr').decode(buf);
      const parsed = parseRoadStations(text);
      if (parsed.length) {
        lastStations = parsed;
        if (parsed.some(s => s.temp !== null || s.roadTemp !== null)) {
          const result = { ok: true, line: String(line), tm1, updatedAt: new Date().toISOString(), stations: parsed };
          setCached(cacheKey, result, 2 * 60000);
          return result;
        }
      }
    }
    if (lastStations.length) {
      const result = { ok: true, line: String(line), updatedAt: new Date().toISOString(), stations: lastStations };
      setCached(cacheKey, result, 60000);
      return result;
    }
    throw new Error('도로기상관측 자료를 가져오지 못했습니다.');
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

async function fetchWrnNowList() {
  const key = getServiceKey();
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
    const r = await fetch(u, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) return [];
    const buf = Buffer.from(await r.arrayBuffer());
    const text = new TextDecoder('euc-kr').decode(buf);
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
    const links = extractCapLinksFromRss(rssXml, 12);
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
      'Cache-Control': safe === '/index.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(data);
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
    "default-src 'self'; img-src 'self' data: blob: https://*.weather.go.kr; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.open-meteo.com https://ensemble-api.open-meteo.com https://geocoding-api.open-meteo.com https://www.weather.go.kr; frame-src https://embed.windy.com https://*.windy.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
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

  if (pathname.startsWith('/api/')) {
    applyApiCors(req, res);
    const ip = getClientIp(req);
    if (!allow(ip)) return sendJson(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 이용해 주세요.' });

    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        status: 'ok',
        forecastConfigured: !!getServiceKey(),
        radarConfigured: !!getRadarKey(),
        roadConfigured: !!getRoadKey(),
        roadLine: ROAD_LINE_CODE
      });
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
      const name = (requestUrl.searchParams.get('name') || '').trim();
      const latRaw = requestUrl.searchParams.get('lat');
      const lonRaw = requestUrl.searchParams.get('lon');
      const lat = latRaw !== null ? Number(latRaw) : NaN;
      const lon = lonRaw !== null ? Number(lonRaw) : NaN;
      try {
        const all = await fetchWrnNowList();
        const hasSubZones = all.some(w => w.regUpKo && w.regKo !== w.regUpKo);
        const capPolyMap = name && hasSubZones ? await getCapPolygonMap() : new Map();
        const matched = name
          ? all.filter(w => warningMatchesPlace(w, name, lat, lon, capPolyMap))
          : all;
        return sendJson(res, 200, { ok: true, updatedAt: new Date().toISOString(), warnings: sortWarnings(matched), totalNational: all.length });
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
  getObservationForPlace,
  parseRoadStations,
  matchRoadStation,
  parseWrnNow,
  sortWarnings,
  inPolygon,
  warningMatchesPlace,
  server
};
