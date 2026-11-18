/**
 * 비온다? × 날씨봇 (RainWatch & RoadWeather Monitor Korea) — zero-dependency Node.js server.
 * Secrets are ONLY read from environment variables, never sent to the browser.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

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
const DATA_GO_KR_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/';
const APIHUB_FCST_BASE = 'https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/';
const ROAD_LINE_CODE = String(process.env.ROAD_LINE_CODE || '14');

function getServiceKey() {
  return process.env.KMA_SERVICE_KEY || process.env.KMA_API_KEY || process.env.KMA_ROAD_KEY || process.env.KMA_RADAR_KEY || '';
}
function getRadarKey() {
  return process.env.KMA_RADAR_KEY || process.env.KMA_SERVICE_KEY || process.env.KMA_API_KEY || process.env.KMA_ROAD_KEY || '';
}
function getRoadKey() {
  return process.env.KMA_ROAD_KEY || process.env.KMA_SERVICE_KEY || process.env.KMA_API_KEY || process.env.KMA_RADAR_KEY || '';
}

const SHARED_CACHE = new Map();
const INFLIGHT = new Map();
const REQUESTS = new Map();

const pad = (n) => String(n).padStart(2, '0');
const kst = (d = Date.now()) => new Date(d + 9 * 3600000);
const datePart = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const timePart = (d) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const isoKst = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+09:00`;
const deEncodedKey = (key) => { try { return decodeURIComponent(key); } catch { return key; } };

function baseUltra(now) {
  const d = kst(now);
  if (d.getUTCMinutes() < 45) d.setUTCHours(d.getUTCHours() - 1);
  d.setUTCMinutes(30, 0, 0);
  return d;
}
function baseShort(now) {
  const d = kst(now - 20 * 60000);
  const slots = [2, 5, 8, 11, 14, 17, 20, 23];
  let hour = slots.filter(x => x <= d.getUTCHours()).at(-1);
  if (hour === undefined) { d.setUTCDate(d.getUTCDate() - 1); hour = 23; }
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}
function baseObservation(now) {
  const d = kst(now - 25 * 60000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}
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
function errMessage(e) {
  return String(e?.message || e).slice(0, 160).replace(/(ServiceKey|authKey)=[^& ]+/gi, '$1=[REDACTED]');
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
  const raw = await r.text();
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new Error('기상청 응답을 JSON으로 읽지 못했습니다. 키 또는 서비스 승인 상태를 확인하세요.'); }
  const response = obj?.response;
  if (response?.header?.resultCode !== '00') throw new Error(`기상청 오류: ${response?.header?.resultMsg || '알 수 없음'}`);
  const items = response?.body?.items?.item;
  if (!Array.isArray(items) || !items.length) throw new Error('해당 발표시각에 제공되는 자료가 없습니다.');
  return items;
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

/** KMA's Lambert Conformal Conic DFS grid transform (official grid constants). */
function latlonToGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180;
  const re = RE / GRID, slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD, olon = OLON * DEGRAD, olat = OLAT * DEGRAD;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

function grouped(items, field = 'fcstValue') {
  const out = new Map();
  for (const item of items || []) {
    const key = `${item.fcstDate || item.baseDate}${item.fcstTime || item.baseTime}`;
    if (!out.has(key)) out.set(key, {});
    out.get(key)[item.category] = String(item[field]);
  }
  return out;
}
function precipType(pty) {
  return ({ '0': '없음', '1': '비', '2': '비·눈', '3': '눈', '4': '소나기', '5': '빗방울', '6': '빗방울·눈날림', '7': '눈날림' })[String(pty)] || '강수';
}
function skyText(sky, pty) {
  const p = String(pty ?? '0');
  if (p !== '0') return precipType(p);
  const s = String(sky ?? '');
  if (s === '1') return '맑음';
  if (s === '3') return '구름많음';
  if (s === '4') return '흐림';
  return '대체로 맑음';
}
function kmaToWmoCode(sky, pty) {
  const p = String(pty ?? '0');
  if (p === '1' || p === '4') return 61;
  if (p === '2' || p === '6') return 68;
  if (p === '3' || p === '7') return 71;
  if (p === '5') return 51;
  const s = String(sky ?? '1');
  if (s === '1') return 0;
  if (s === '3') return 2;
  if (s === '4') return 3;
  return 1;
}
function amountNumber(v) {
  if (!v || /강수없음|적설없음|없음/.test(v)) return 0;
  if (/미만/.test(v)) return 0.1;
  return Number.parseFloat(v) || 0;
}
function classify(hour) {
  const pty = String(hour.PTY ?? '0');
  const rainMm = amountNumber(hour.RN1 ?? hour.PCP);
  const snowCm = amountNumber(hour.SNO);
  const prob = hour.POP == null ? null : Number(hour.POP);
  const wet = pty !== '0' || rainMm > 0 || snowCm > 0;
  const wsd = hour.WSD != null && Number.isFinite(Number(hour.WSD)) ? Number(hour.WSD) : null;
  return {
    type: wet ? precipType(pty !== '0' ? pty : (snowCm > 0 ? '3' : '1')) : '없음',
    wet,
    chance: prob != null && Number.isFinite(prob) ? prob : null,
    risk: !wet && prob != null && prob >= 50,
    amount: hour.RN1 ?? hour.PCP ?? null,
    rainMm,
    snowCm,
    temp: hour.T1H ?? hour.TMP ?? null,
    humidity: hour.REH ?? null,
    wind: wsd,
    sky: hour.SKY ?? null,
    skyLabel: skyText(hour.SKY, pty),
    weatherCode: kmaToWmoCode(hour.SKY, pty),
    snow: hour.SNO ?? null,
    source: hour.__source || '단기예보'
  };
}
function analyze(hourly, observed) {
  const wet = hourly.map(h => !!h.wet);
  const startIndex = wet.findIndex(Boolean);
  let endIndex = null;
  if (startIndex >= 0) {
    for (let i = startIndex + 1; i < wet.length; i++) {
      if (!wet[i] && !wet[i + 1] && wet[i + 1] !== undefined) { endIndex = i; break; }
    }
  }
  const wetIndices = wet.reduce((acc, v, idx) => (v ? [...acc, idx] : acc), []);
  const lastWetIndex = wetIndices.length ? wetIndices.at(-1) : -1;
  const windowEndTime = hourly.length ? hourly.at(-1).time : null;
  const allWindowWet = hourly.length > 0 && wet.every(Boolean);

  let secondStartIndex = -1;
  if (endIndex != null) {
    for (let i = endIndex + 1; i < wet.length; i++) {
      if (wet[i]) { secondStartIndex = i; break; }
    }
  }

  const makeHorizon = n => {
    const block = hourly.filter(h => h.offset <= n);
    const possibilities = block.filter(h => h.wet || h.risk);
    const precip = block.filter(h => h.wet);
    return {
      hours: n,
      hasPrecipitation: precip.length > 0,
      hasRisk: possibilities.length > 0,
      kinds: [...new Set(precip.map(h => h.type))],
      maxChance: block.some(h => h.chance != null) ? Math.max(...block.map(h => h.chance ?? 0)) : null
    };
  };
  const makeRange = (minOffset, maxOffset, label) => {
    const block = hourly.filter(h => h.offset >= minOffset && h.offset <= maxOffset);
    const possibilities = block.filter(h => h.wet || h.risk);
    const precip = block.filter(h => h.wet);
    return {
      label,
      minOffset,
      maxOffset,
      hasPrecipitation: precip.length > 0,
      hasRisk: possibilities.length > 0,
      kinds: [...new Set(precip.map(h => h.type))],
      maxChance: block.some(h => h.chance != null) ? Math.max(...block.map(h => h.chance ?? 0)) : null
    };
  };
  return {
    now: observed,
    windowHours: hourly.length,
    windowEndTime,
    wetHoursCount: wetIndices.length,
    allWindowWet,
    lastWetTime: lastWetIndex >= 0 ? hourly[lastWetIndex].time : null,
    secondStartTime: secondStartIndex >= 0 ? hourly[secondStartIndex].time : null,
    start: startIndex >= 0 ? { time: hourly[startIndex].time, current: !!observed?.wet && startIndex === 0 } : null,
    end: endIndex != null ? { time: hourly[endIndex].time, rule: '연속 2시간 무강수 예보' } : null,
    extendsBeyondWindow: startIndex >= 0 && endIndex == null,
    noRainSignal: startIndex === -1,
    horizons: [makeHorizon(3), makeHorizon(6), makeHorizon(12)],
    horizonRanges: [
      makeRange(1, 3, '향후 3시간'),
      makeRange(4, 6, '3~6시간'),
      makeRange(7, 12, '향후 6~12시간')
    ]
  };
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
  const [ultra, short, actual] = requests.map(x => x.status === 'fulfilled' ? x.value : null);
  if (!ultra && !short) throw new Error('초단기·단기 예보를 모두 가져오지 못했습니다. 발급된 API 키의 승인 여부를 확인하세요.');
  const near = grouped(ultra?.items), far = grouped(short?.items);
  const nowK = kst(now); nowK.setUTCMinutes(0, 0, 0);
  const hourly = [];
  for (let i = 1; i <= 12; i++) {
    const d = new Date(nowK.getTime() + i * 3600000);
    const key = datePart(d) + timePart(d);
    const sourceNear = near.get(key), sourceFar = far.get(key);
    const combined = { ...(sourceFar || {}), ...(sourceNear || {}), __source: sourceNear ? '초단기예보' : '단기예보' };
    if (!sourceNear && !sourceFar) continue;
    hourly.push({ time: isoKst(d), offset: i, ...classify(combined) });
  }
  const observations = actual?.items || [];
  const values = {}; for (const o of observations) values[o.category] = o.obsrValue;
  const observed = actual ? {
    type: precipType(values.PTY || '0'),
    wet: String(values.PTY || '0') !== '0' || amountNumber(values.RN1) > 0,
    amount: values.RN1 ?? null,
    temp: values.T1H ?? null,
    humidity: values.REH ?? null,
    wind: values.WSD ?? null,
    time: actual.base
  } : null;
  return {
    ok: true,
    grid,
    updatedAt: new Date().toISOString(),
    sources: { ultra: ultra?.base || null, short: short?.base || null, observed: actual?.base || null },
    notices: requests.filter(x => x.status === 'rejected').map(x => errMessage(x.reason)).slice(0, 3),
    hours: hourly,
    analysis: analyze(hourly, observed)
  };
}

/**
 * 3.1.2 고속도로 노선으로 조회API (road_stn_obs.php?mode=2&var=14 무안광주대구선 → 실제 고속국도 제12호선)
 * 이정(km)은 한국도로공사 고령지사 MMF 도로DB(roads-db-v3.json) 기준 실측 정합
 */
const ROUTE12_MILEPOST_BY_STN = {
  '14402': { routeNo: '12', section: '무안광주선', km: 8.9 },
  '14202': { routeNo: '12', section: '무안광주선', km: 12.4 },
  '14403': { routeNo: '12', section: '무안광주선', km: 29.6 },
  '14203': { routeNo: '12', section: '무안광주선', km: 38.8 },
  '14404': { routeNo: '12', section: '무안광주선', km: 41.1 },
  '14405': { routeNo: '12', section: '광주대구선', km: 19.2 },
  '14204': { routeNo: '12', section: '광주대구선', km: 27.0 },
  '14406': { routeNo: '12', section: '광주대구선', km: 30.6 },
  '14302': { routeNo: '12', section: '광주대구선', km: 36.5 },
  '14205': { routeNo: '12', section: '광주대구선', km: 50.8 },
  '14407': { routeNo: '12', section: '광주대구선', km: 72.9 },
  '14102': { routeNo: '12', section: '광주대구선', km: 75.4 },
  '14408': { routeNo: '12', section: '광주대구선', km: 86.2 },
  '14206': { routeNo: '12', section: '광주대구선', km: 95.0 },
  '14409': { routeNo: '12', section: '광주대구선', km: 102.9 },
  '14207': { routeNo: '12', section: '광주대구선', km: 115.3 },
  '14208': { routeNo: '12', section: '광주대구선', km: 134.1 },
  '14209': { routeNo: '12', section: '광주대구선', km: 158.2 },
  '14103': { routeNo: '12', section: '광주대구선', km: 169.2 },
  '14410': { routeNo: '12', section: '광주대구선', km: 171.3 }
};

const SURFACE_STATES = {
  1: '건조',
  2: '습윤',
  3: '수막',
  4: '적설',
  5: '결빙',
  6: '슬러시',
  7: '소금물'
};

function parseRoadStations(rawText) {
  const stations = [];
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 19) continue;
    const tmRaw = parts[0];
    const stnId = parts[1];
    const name = parts[2];
    const roadName = parts[3];
    const stationType = parts[4];
    const lat = Number(parts[5]);
    const lon = Number(parts[6]);
    const elevation = Number(parts[7]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const numOrNull = (val, minValid = -90) => {
      const n = Number(val);
      return Number.isFinite(n) && n > minValid ? n : null;
    };
    const sfs = numOrNull(parts[8], 0);
    const tr1 = numOrNull(parts[9], -80);
    const vs = numOrNull(parts[10], 0);
    const hm = numOrNull(parts[11], 0);
    const rnDay = numOrNull(parts[12], -1);
    const sd = numOrNull(parts[13], -1);
    const ta = numOrNull(parts[14], -80);
    const wd1 = numOrNull(parts[15], -1);
    const ws1 = numOrNull(parts[16], -1);
    const wsIns = numOrNull(parts[18], -1);
    const ps = numOrNull(parts[19], 0);

    let isoTime = null;
    if (/^\d{12}$/.test(tmRaw)) {
      isoTime = `${tmRaw.slice(0, 4)}-${tmRaw.slice(4, 6)}-${tmRaw.slice(6, 8)}T${tmRaw.slice(8, 10)}:${tmRaw.slice(10, 12)}:00+09:00`;
    }
    const mp = ROUTE12_MILEPOST_BY_STN[stnId] || null;
    stations.push({
      tm: tmRaw,
      time: isoTime,
      stnId,
      name,
      roadName,
      routeNo: mp?.routeNo || '12',
      roadSection: mp?.section || roadName,
      milepostKm: mp?.km ?? null,
      stationType,
      lat,
      lon,
      elevation: Number.isFinite(elevation) ? elevation : null,
      surfaceCode: sfs,
      surfaceState: sfs ? (SURFACE_STATES[sfs] || '관측중') : null,
      roadTemp: tr1,
      visibility: vs,
      humidity: hm,
      dayPrecip: rnDay,
      snowDepth: sd,
      temp: ta,
      windDir: wd1,
      windSpeed: ws1,
      gustSpeed: wsIns,
      pressure: ps
    });
  }
  return stations;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function matchRoadStation(lat, lon, stations) {
  if (!Array.isArray(stations) || !stations.length) return null;
  const withDist = stations.map(s => ({ ...s, distanceKm: Number(distanceKm(lat, lon, s.lat, s.lon).toFixed(2)) }));
  const metStations = withDist.filter(s => s.temp !== null).sort((a, b) => a.distanceKm - b.distanceKm);
  const roadStations = withDist.filter(s => s.roadTemp !== null).sort((a, b) => a.distanceKm - b.distanceKm);
  const bridgeStations = withDist.filter(s => s.roadTemp !== null && s.stationType?.includes('결빙')).sort((a, b) => a.distanceKm - b.distanceKm);

  const primary = metStations[0] || roadStations[0] || withDist.sort((a, b) => a.distanceKm - b.distanceKm)[0];
  if (!primary) return null;
  const nearestRoad = roadStations[0] || primary;
  const nearestBridge = bridgeStations[0] && bridgeStations[0].distanceKm <= 25 ? bridgeStations[0] : null;

  return {
    name: primary.name,
    stnId: primary.stnId,
    routeNo: primary.routeNo || '12',
    milepostKm: primary.milepostKm ?? null,
    roadName: primary.roadName || '무안광주대구선',
    stationType: primary.stationType,
    elevation: primary.elevation,
    distanceKm: primary.distanceKm,
    time: primary.time || nearestRoad.time,
    temp: primary.temp,
    humidity: primary.humidity,
    dayPrecip: primary.dayPrecip,
    snowDepth: primary.snowDepth,
    windSpeed: primary.windSpeed,
    gustSpeed: primary.gustSpeed,
    visibility: primary.visibility,
    roadStationName: nearestRoad.name,
    roadMilepostKm: nearestRoad.milepostKm ?? null,
    roadDistanceKm: nearestRoad.distanceKm,
    roadTemp: nearestRoad.roadTemp,
    surfaceCode: nearestRoad.surfaceCode,
    surfaceState: nearestRoad.surfaceState,
    bridgeStationName: nearestBridge ? nearestBridge.name : null,
    bridgeMilepostKm: nearestBridge ? (nearestBridge.milepostKm ?? null) : null,
    bridgeDistanceKm: nearestBridge ? nearestBridge.distanceKm : null,
    bridgeRoadTemp: nearestBridge ? nearestBridge.roadTemp : null,
    bridgeSurfaceState: nearestBridge ? nearestBridge.surfaceState : null,
    source: `기상청 도로기상관측망 (고속국도 12호선 광주대구선 · API코드 14)`
  };
}

async function fetchRoadStations(line = ROAD_LINE_CODE) {
  const key = getRoadKey();
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const cacheKey = `road-obs|${line}`;
  const hit = getCached(cacheKey);
  if (hit) return hit;

  return withInFlight(cacheKey, async () => {
    const now = Date.now();
    // Try 2, 4, and 8 minutes ago in KST so current-minute ingestion delay never yields -999
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
    if (res) {
      const vals = {};
      for (const o of res.items || []) vals[o.category] = o.obsrValue;
      const pty = String(vals.PTY || '0');
      kmaNcst = {
        name: `기상청 격자(${grid.nx},${grid.ny})`,
        distanceKm: 0,
        time: res.base,
        temp: vals.T1H != null ? Number(vals.T1H) : null,
        humidity: vals.REH != null ? Number(vals.REH) : null,
        dayPrecip: vals.RN1 != null ? amountNumber(vals.RN1) : null,
        windSpeed: vals.WSD != null ? Number(vals.WSD) : null,
        pty,
        description: pty !== '0' ? precipType(pty) : null,
        source: '기상청 초단기실황'
      };
    }
  } catch {}

  if (!roadMatch && !kmaNcst) throw new Error('기상청 실황 관측 자료를 불러오지 못했습니다.');

  const out = roadMatch ? {
    ...roadMatch,
    temp: roadMatch.temp ?? kmaNcst?.temp ?? null,
    humidity: roadMatch.humidity ?? kmaNcst?.humidity ?? null,
    dayPrecip: roadMatch.dayPrecip ?? kmaNcst?.dayPrecip ?? 0,
    windSpeed: roadMatch.windSpeed ?? kmaNcst?.windSpeed ?? null,
    description: kmaNcst?.description || (roadMatch.surfaceCode >= 4 ? `노면 ${roadMatch.surfaceState}` : null)
  } : {
    name: kmaNcst.name,
    roadName: null,
    stationType: '격자실황',
    distanceKm: 0,
    time: kmaNcst.time,
    temp: kmaNcst.temp,
    roadTemp: null,
    bridgeRoadTemp: null,
    surfaceCode: null,
    surfaceState: null,
    humidity: kmaNcst.humidity,
    dayPrecip: kmaNcst.dayPrecip ?? 0,
    snowDepth: null,
    windSpeed: kmaNcst.windSpeed,
    gustSpeed: null,
    visibility: null,
    description: kmaNcst.description,
    source: kmaNcst.source
  };

  setCached(cacheKey, out, 90000);
  return out;
}

/**
 * 기상특보 전종 파싱 및 도로관리 위험도 우선순위 정렬 (요구사항 3)
 */
const WARNING_TYPE_PRIORITY = {
  '태풍': 1,
  '대설': 2,
  '호우': 3,
  '폭풍해일': 4,
  '지진해일': 5,
  '한파': 6,
  '강풍': 7,
  '안개': 8,
  '풍랑': 9,
  '폭염': 10,
  '건조': 11,
  '황사': 12,
  '열대야': 13
};
const WARNING_LEVEL_PRIORITY = {
  '경보': 1,
  '주의보': 2,
  '주의': 2,
  '예비특보': 3,
  '예비': 3
};

function normalizeLevel(lvl) {
  const s = String(lvl || '').trim();
  if (s.includes('경보') || /warning/i.test(s)) return '경보';
  if (s.includes('주의') || /advisory|watch/i.test(s)) return '주의보';
  if (s.includes('예비') || /preliminary/i.test(s)) return '예비특보';
  return '특보';
}

function formatKstStamp(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{12}$/.test(s)) return s || '미정';
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const hh = s.slice(8, 10);
  const mm = s.slice(10, 12);
  // Preliminary warning special codes from KMA wrn_now_data.php
  const prelimMap = {
    '0259': '새벽(00~03시)', '0559': '새벽(03~06시)', '0859': '아침(06~09시)',
    '1159': '오전(09~12시)', '1459': '낮(12~15시)', '1759': '늦은오후(15~18시)',
    '2059': '저녁(18~21시)', '2359': '밤(21~24시)', '1158': '오전(06~12시)',
    '1758': '오후(12~18시)', '0558': '새벽(00~06시)', '2358': '밤(18~24시)', '1458': '오후(12~18시)'
  };
  if (prelimMap[hh + mm]) return `${pad(m)}-${pad(d)} ${prelimMap[hh + mm]}`;
  return `${pad(m)}-${pad(d)} ${hh}:${mm}`;
}

function parseWrnNow(rawText) {
  const list = [];
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map(s => s.trim());
    if (parts.length < 10) continue;
    const [regUp, regUpKo, regId, regKo, tmFc, tmEf, wrn, lvl, cmd, edTm] = parts;
    if (/해제|취소/.test(cmd)) continue;
    const level = normalizeLevel(lvl);
    const title = level === '예비특보' ? `${wrn} 예비특보` : `${wrn}${level}`;
    const typeRank = WARNING_TYPE_PRIORITY[wrn] || 20;
    const levelRank = WARNING_LEVEL_PRIORITY[level] || 4;
    const priorityScore = levelRank * 100 + typeRank;
    const nowKstStr = (() => { const d = kst(); return datePart(d) + timePart(d); })();
    const isFuture = /^\d{12}$/.test(tmEf) && tmEf > nowKstStr;
    list.push({
      regUp,
      regUpKo,
      regId,
      regKo,
      tmFc,
      tmEf,
      kind: wrn,
      level,
      title,
      cmd,
      announcedText: formatKstStamp(tmFc),
      effectiveText: formatKstStamp(tmEf),
      isFutureEffective: isFuture || level === '예비특보',
      expiresText: edTm ? edTm.replace(/,=$/, '').trim() : '기상청 추후 발표',
      priorityScore
    });
  }
  return list.sort((a, b) => a.priorityScore - b.priorityScore);
}

function sortWarnings(warnings) {
  return [...(warnings || [])].sort((a, b) => (a.priorityScore ?? 999) - (b.priorityScore ?? 999));
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

function inPolygon(lat, lon, polygon) {
  const pts = String(polygon || '').trim().split(/\s+/).map(s => s.split(',').map(Number));
  if (pts.length < 3 || pts.some(p => p.length !== 2 || !p.every(Number.isFinite))) return false;
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [y, x] = pts[i], [yy, xx] = pts[j];
    if ((y > lat) !== (yy > lat) && lon < (xx - x) * (lat - y) / (yy - y) + x) hit = !hit;
  }
  return hit;
}

async function getCapPolygonMap() {
  const cached = getCached('kma-cap-polygons');
  if (cached) return cached;
  const polyMap = new Map();
  try {
    const rssXml = await fetchCapXml('');
    const links = [...rssXml.matchAll(/<link>(https?:\/\/[^<]+)<\/link>/g)]
      .map(m => m[1])
      .map(u => {
        const m = u.match(/\/w\/repositary\/xml\/wrn\/xml\/([^/]+\.xml)$/);
        return m ? m[1].replace(/_EN\.xml$/, '_KR.xml') : null;
      })
      .filter(Boolean)
      .slice(0, 12);

    const docs = await Promise.allSettled(links.map(f => fetchCapXml(f)));
    for (const res of docs) {
      if (res.status !== 'fulfilled') continue;
      const areas = res.value.match(/<area>[\s\S]*?<\/area>/g) || [];
      for (const a of areas) {
        const desc = a.match(/<areaDesc>([^<]+)<\/areaDesc>/)?.[1]?.replace(/\s+/g, '');
        const polys = [...a.matchAll(/<polygon>([^<]+)<\/polygon>/g)].map(m => m[1]);
        if (desc && polys.length) {
          const prev = polyMap.get(desc) || [];
          polyMap.set(desc, [...prev, ...polys]);
        }
      }
    }
  } catch {}
  setCached('kma-cap-polygons', polyMap, 120000);
  return polyMap;
}

function warningMatchesPlace(w, targetName, lat, lon, capPolyMap) {
  const clean = s => String(s || '').replace(/\s+/g, '');
  const target = clean(targetName);
  if (!target) return true;
  const rKo = clean(w.regKo);
  const rUp = clean(w.regUpKo);
  if (rKo === target || (rKo.length >= 2 && target.includes(rKo))) return true;

  const isSubZone = Boolean((rUp && rKo !== rUp) || /(서북|서남|동북|동남|중북|중남|동부|서부|남부|북부|중부|산지|평지)$/.test(rKo));
  if (isSubZone) {
    if (Number.isFinite(lat) && Number.isFinite(lon) && capPolyMap?.has(rKo)) {
      return capPolyMap.get(rKo).some(poly => inPolygon(lat, lon, poly));
    }
    const cleanDir = s => s.replace(/군|시|구/g, '');
    return cleanDir(rKo) === cleanDir(target);
  }

  if (rKo.includes(target)) return true;
  const prefix2 = target.slice(0, 2);
  if (prefix2.length === 2 && ['함양', '거창', '합천', '고령', '남원', '달성'].includes(prefix2)) {
    return rKo.includes(prefix2) || rUp.includes(prefix2);
  }
  return false;
}

async function radarImage() {
  const radarKey = getRadarKey();
  if (!radarKey) throw new Error('KMA_RADAR_KEY 미설정');
  const cache = getCached('radar-visual'); if (cache) return cache;
  const u = new URL('https://apihub.kma.go.kr/api/typ03/cgi/rdr/nph-rdr_cmp1_img');
  const p = { cmp: 'HSR', qcd: 'HSLP', obs: 'ECHD', color: 'C4', aws: '0', map: 'HR', grid: '2', legend: '1', size: '800', itv: '5', zoom_level: '0', zoom_x: '0000000', zoom_y: '0000000', gov: '', authKey: deEncodedKey(radarKey) };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`레이더 서버 오류 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 6_000_000) throw new Error('레이더 이미지 용량 제한 초과');
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isGif = buf.toString('ascii', 0, 3) === 'GIF';
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isGif && !isJpg) throw new Error('레이더 API에서 이미지가 아닌 응답을 받았습니다. API허브 키 권한을 확인하세요.');
  const out = { buf, type: isPng ? 'image/png' : isGif ? 'image/gif' : 'image/jpeg' };
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
