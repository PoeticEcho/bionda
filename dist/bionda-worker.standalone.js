// Auto-generated standalone single-file Cloudflare Worker bundle
// Build: npm run build:worker

/**
 * 비온다? × 날씨봇 — 런타임 공통 순수 KMA 파싱·격자·도로관측·특보 엔진
 * Node.js (server.js)와 Cloudflare Workers (cloudflare/worker.js)가 동일 로직을 공유합니다.
 */
const DATA_GO_KR_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/';
const APIHUB_FCST_BASE = 'https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/';

function getServiceKey(env = {}) {
  return env.KMA_SERVICE_KEY || env.KMA_API_KEY || env.KMA_ROAD_KEY || env.KMA_RADAR_KEY || '';
}
function getRadarKey(env = {}) {
  return env.KMA_RADAR_KEY || env.KMA_SERVICE_KEY || env.KMA_API_KEY || env.KMA_ROAD_KEY || '';
}
function getRoadKey(env = {}) {
  return env.KMA_ROAD_KEY || env.KMA_SERVICE_KEY || env.KMA_API_KEY || env.KMA_RADAR_KEY || '';
}
function getRoadLineCode(env = {}) {
  return String(env.ROAD_LINE_CODE || '14');
}

const pad = (n) => String(n).padStart(2, '0');
const kst = (d = Date.now()) => new Date(d + 9 * 3600000);
const datePart = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const timePart = (d) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const isoKst = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+09:00`;
const deEncodedKey = (key) => { try { return decodeURIComponent(key); } catch { return key; } };

function errMessage(e) {
  return String(e?.message || e).slice(0, 160).replace(/(ServiceKey|authKey)=[^& ]+/gi, '$1=[REDACTED]');
}

function baseUltra(now) {
  const d = kst(now);
  // KMA APIHub 초단기예보는 매시 30분대 중반(35분 무렵)부터 당해 시각(HH00, +1~+6h) 발표분이 조회 가능하므로
  // 35분 미만이면 직전 시각 HH30을 우선 시도하고, 아직 미생성 시 호출부 fallback으로 직전 발표분을 사용한다.
  if (d.getUTCMinutes() < 35) d.setUTCHours(d.getUTCHours() - 1);
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
function kmaToWmoCode(sky, pty, lightning = false) {
  const p = String(pty ?? '0');
  if (lightning) return p !== '0' ? 95 : 95;
  if (p === '1' || p === '4') return 61;
  if (p === '2' || p === '6') return 68;
  if (p === '3' || p === '7') return 71;
  if (p === '5') return 51;
  const s = String(sky ?? '1');
  if (s === '1') return 0;
  if (s === '2' || s === '3') return 2;
  if (s === '4') return 3;
  return 1;
}
function amountNumber(v) {
  if (!v || /강수없음|적설없음|없음/.test(v)) return 0;
  if (/미만/.test(v)) return 0.1;
  return Number.parseFloat(v) || 0;
}
const WIND_DIRS_16 = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
function windDirKo(deg) {
  if (deg == null || !Number.isFinite(Number(deg))) return '-';
  const idx = Math.floor(((Number(deg) % 360) + 360 + 11.25) / 22.5) % 16;
  return WIND_DIRS_16[idx];
}
function classify(hour) {
  const pty = String(hour.PTY ?? '0');
  const rainMm = amountNumber(hour.RN1 ?? hour.PCP);
  const snowCm = amountNumber(hour.SNO);
  const prob = hour.POP == null ? null : Number(hour.POP);
  const wet = pty !== '0' || rainMm > 0 || snowCm > 0;
  const lightning = hour.LGT != null && Number.isFinite(Number(hour.LGT)) && Number(hour.LGT) > 0;
  const wsd = hour.WSD != null && Number.isFinite(Number(hour.WSD)) ? Number(hour.WSD) : null;
  const vec = hour.VEC != null && Number.isFinite(Number(hour.VEC)) ? Number(hour.VEC) : null;
  return {
    type: wet ? precipType(pty !== '0' ? pty : (snowCm > 0 ? '3' : '1')) : '없음',
    wet,
    pty,
    lightning,
    chance: prob != null && Number.isFinite(prob) ? prob : null,
    risk: !wet && prob != null && prob >= 50,
    amount: hour.RN1 ?? hour.PCP ?? null,
    rainMm,
    snowCm,
    temp: hour.T1H ?? hour.TMP ?? null,
    humidity: hour.REH ?? null,
    wind: wsd,
    vec,
    windDir: windDirKo(vec),
    sky: hour.SKY ?? null,
    skyLabel: lightning ? (wet ? `${precipType(pty)}·번개` : '뇌우·번개') : skyText(hour.SKY, pty),
    weatherCode: kmaToWmoCode(hour.SKY, pty, lightning),
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

function buildForecastResult(grid, now, requests) {
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

function parseKmaForecastJson(rawText) {
  let obj;
  try { obj = JSON.parse(rawText); } catch { throw new Error('기상청 응답을 JSON으로 읽지 못했습니다. 키 또는 서비스 승인 상태를 확인하세요.'); }
  const response = obj?.response;
  if (response?.header?.resultCode !== '00') throw new Error(`기상청 오류: ${response?.header?.resultMsg || '알 수 없음'}`);
  const items = response?.body?.items?.item;
  if (!Array.isArray(items) || !items.length) throw new Error('해당 발표시각에 제공되는 자료가 없습니다.');
  return items;
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
  // 결빙취약교량(목표(결빙))은 생활권·동일 구간(14km 이내)으로 제한하고, 최근접 노면관측소 자체와 중복 매칭하지 않음
  const rawBridge = bridgeStations[0] && bridgeStations[0].distanceKm <= 14 ? bridgeStations[0] : null;
  const nearestBridge = rawBridge && rawBridge.stnId !== nearestRoad.stnId ? rawBridge : null;

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
    roadStationType: nearestRoad.stationType || null,
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

function parseNcstValues(res, grid) {
  if (!res) return null;
  const vals = {};
  for (const o of res.items || []) vals[o.category] = o.obsrValue;
  const pty = String(vals.PTY || '0');
  return {
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

function mergeObservationResult(roadMatch, kmaNcst) {
  if (!roadMatch && !kmaNcst) throw new Error('기상청 실황 관측 자료를 불러오지 못했습니다.');
  return roadMatch ? {
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

function extractCapLinksFromRss(rssXml, limit = 12) {
  return [...String(rssXml || '').matchAll(/<link>(https?:\/\/[^<]+)<\/link>/g)]
    .map(m => m[1])
    .map(u => {
      const m = u.match(/\/w\/repositary\/xml\/wrn\/xml\/([^/]+\.xml)$/);
      return m ? m[1].replace(/_EN\.xml$/, '_KR.xml') : null;
    })
    .filter(Boolean)
    .slice(0, limit);
}

function populateCapPolygons(capXml, polyMap) {
  const areas = String(capXml || '').match(/<area>[\s\S]*?<\/area>/g) || [];
  for (const a of areas) {
    const desc = a.match(/<areaDesc>([^<]+)<\/areaDesc>/)?.[1]?.replace(/\s+/g, '');
    const polys = [...a.matchAll(/<polygon>([^<]+)<\/polygon>/g)].map(m => m[1]);
    if (desc && polys.length) {
      const prev = polyMap.get(desc) || [];
      polyMap.set(desc, [...prev, ...polys]);
    }
  }
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

function detectRadarImageType(bytes) {
  if (!bytes || bytes.length > 6_000_000) throw new Error('레이더 이미지 용량 제한 초과');
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isGif && !isJpg) throw new Error('레이더 API에서 이미지가 아닌 응답을 받았습니다. API허브 키 권한을 확인하세요.');
  return isPng ? 'image/png' : isGif ? 'image/gif' : 'image/jpeg';
}

/**
 * 3.1.3 도로 위험기상정보 파일 API (road_file_down.php · roadNum=012 무안광주대구선 · 5분 UTC 생산)
 * 위험수준: 0(정보없음/안개없음) / 1(관심) / 2(주의) / 3(위험)
 */
const ROAD_ICE_LABELS = ['정보없음', '관심', '주의', '위험'];
const ROAD_FOG_LABELS = ['안개없음', '관심', '주의', '위험'];

const CORRIDOR_ANCHOR_STATIONS = [
  { stnId: '14205', name: '남원주차장(도)', stationType: '기본', km: 50.8, lat: 35.4162, lon: 127.3446 },
  { stnId: '14407', name: '번암교(도)', stationType: '목표(결빙)', km: 72.9, lat: 35.4748, lon: 127.5443 },
  { stnId: '14102', name: '지리산휴(도)', stationType: '거점', km: 75.4, lat: 35.4826, lon: 127.5692 },
  { stnId: '14408', name: '옥계1교(도)', stationType: '목표(결빙)', km: 86.2, lat: 35.5384, lon: 127.6553 },
  { stnId: '14206', name: '함양(도)', stationType: '기본', km: 95.0, lat: 35.5327, lon: 127.7495 },
  { stnId: '14409', name: '죽산천교(도)', stationType: '목표(결빙)', km: 102.9, lat: 35.5486, lon: 127.8289 },
  { stnId: '14207', name: '남상졸음(도)', stationType: '기본', km: 115.3, lat: 35.6366, lon: 127.9066 },
  { stnId: '14208', name: '거창휴(도)', stationType: '기본', km: 134.1, lat: 35.7074, lon: 128.0541 },
  { stnId: '14209', name: '양전교(도)', stationType: '기본', km: 158.2, lat: 35.7247, lon: 128.2979 },
  { stnId: '14103', name: '논공휴(도)', stationType: '거점', km: 169.2, lat: 35.7653, lon: 128.4015 },
  { stnId: '14410', name: '논공교(도)', stationType: '목표(결빙)', km: 171.3, lat: 35.7681, lon: 128.4230 }
];

const CORRIDOR_WATCHED_PLACES = [
  { name: '대구 달성군남부', site: '현풍읍', lat: 35.697, lon: 128.447 },
  { name: '함양중부', site: '지곡면', lat: 35.566, lon: 127.774 },
  { name: '거창군남부', site: '남상면', lat: 35.644, lon: 127.910 },
  { name: '합천군서북부', site: '야로면', lat: 35.706, lon: 128.168 },
  { name: '고령군', site: '대가야읍', lat: 35.728, lon: 128.263 },
  { name: '남원', site: '남원시청', lat: 35.416, lon: 127.390 },
  { name: '함양', site: '함양읍', lat: 35.520, lon: 127.725 },
  { name: '거창', site: '거창읍', lat: 35.687, lon: 127.910 }
];

function utcFiveMinSlot(ms = Date.now()) {
  const d = new Date(ms);
  const m = Math.floor(d.getUTCMinutes() / 5) * 5;
  d.setUTCMinutes(m, 0, 0);
  return {
    tmUtc: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`,
    tmKst: isoKst(kst(d.getTime()))
  };
}

async function extractZipTextEntries(bytes, fileFilter = () => true) {
  if (!bytes || bytes.length < 22) throw new Error('유효한 ZIP 파일이 아닙니다.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 중앙 디렉터리를 찾지 못했습니다.');

  const totalEntries = view.getUint16(eocd + 10, true);
  let cdOff = view.getUint32(eocd + 16, true);
  const decUtf8 = new TextDecoder('utf-8');
  const out = {};

  for (let k = 0; k < totalEntries && cdOff + 46 <= bytes.length; k++) {
    if (view.getUint32(cdOff, true) !== 0x02014b50) break;
    const method = view.getUint16(cdOff + 10, true);
    const compSize = view.getUint32(cdOff + 20, true);
    const fnLen = view.getUint16(cdOff + 28, true);
    const exLen = view.getUint16(cdOff + 30, true);
    const cmLen = view.getUint16(cdOff + 32, true);
    const localOff = view.getUint32(cdOff + 42, true);
    const fileName = decUtf8.decode(bytes.subarray(cdOff + 46, cdOff + 46 + fnLen));
    cdOff += 46 + fnLen + exLen + cmLen;

    if (!fileFilter(fileName)) continue;
    if (localOff + 30 > bytes.length) continue;
    const lFnLen = view.getUint16(localOff + 26, true);
    const lExLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lFnLen + lExLen;
    const compBytes = bytes.subarray(dataStart, dataStart + compSize);

    let plainBytes;
    if (method === 0) {
      plainBytes = compBytes;
    } else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compBytes);
      writer.close();
      plainBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    } else {
      continue;
    }
    out[fileName] = decUtf8.decode(plainBytes);
  }
  return out;
}

function parseRoadRiskCsv(csvText) {
  const lines = String(csvText || '').split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].trim().split(',');
  const is1Km = header[1] === 'S_NUM' || header.includes('FLAG');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(',');
    let fLon, fLat, tLon, tLat, lv, flag;
    if (is1Km) {
      if (p.length < 8) continue;
      fLon = Number(p[2]); fLat = Number(p[3]); tLon = Number(p[4]); tLat = Number(p[5]);
      lv = Number(p[6]); flag = Number(p[7]);
    } else {
      if (p.length < 8) continue;
      fLon = Number(p[3]); fLat = Number(p[4]); tLon = Number(p[5]); tLat = Number(p[6]);
      lv = Number(p[7]); flag = 0;
    }
    if (!Number.isFinite(fLat) || !Number.isFinite(fLon) || !Number.isFinite(lv)) continue;
    const lat = Number.isFinite(tLat) ? (fLat + tLat) / 2 : fLat;
    const lon = Number.isFinite(tLon) ? (fLon + tLon) / 2 : fLon;
    rows.push({ lat, lon, level: Math.max(0, Math.min(3, lv)), flag: flag === 1 ? 1 : 0 });
  }
  return rows;
}

function summarizeSegmentWindow(lat, lon, frgRows, fogRows, radiusKm = 2.5) {
  let maxIce = 0, maxFog = 0, observed = false;
  const iceCounts = [0, 0, 0, 0];
  const fogCounts = [0, 0, 0, 0];
  let nearestDist = Infinity, nearestIce = 0, nearestFog = 0;
  let segCount = 0;

  // Rough bounding box (~1 deg lat ≈ 111km, lon ≈ 90km) before Haversine keeps loop < 1ms
  const latDeg = radiusKm / 100;
  const lonDeg = radiusKm / 80;

  for (let i = 0; i < frgRows.length; i++) {
    const r = frgRows[i];
    if (Math.abs(r.lat - lat) > latDeg || Math.abs(r.lon - lon) > lonDeg) continue;
    const d = distanceKm(lat, lon, r.lat, r.lon);
    if (d <= radiusKm) {
      segCount++;
      iceCounts[r.level] = (iceCounts[r.level] || 0) + 1;
      if (r.level > maxIce) maxIce = r.level;
      if (r.flag === 1) observed = true;
      if (d < nearestDist) { nearestDist = d; nearestIce = r.level; }
    }
  }
  let nearestFogDist = Infinity;
  for (let i = 0; i < fogRows.length; i++) {
    const r = fogRows[i];
    if (Math.abs(r.lat - lat) > latDeg || Math.abs(r.lon - lon) > lonDeg) continue;
    const d = distanceKm(lat, lon, r.lat, r.lon);
    if (d <= radiusKm) {
      fogCounts[r.level] = (fogCounts[r.level] || 0) + 1;
      if (r.level > maxFog) maxFog = r.level;
      if (d < nearestFogDist) { nearestFogDist = d; nearestFog = r.level; }
    }
  }

  return {
    segmentCount: segCount,
    nearestDistKm: Number.isFinite(nearestDist) ? Number(nearestDist.toFixed(2)) : null,
    nearestIce,
    nearestFog,
    iceLevel: maxIce,
    iceLabel: ROAD_ICE_LABELS[maxIce] || '정보없음',
    fogLevel: maxFog,
    fogLabel: ROAD_FOG_LABELS[maxFog] || '안개없음',
    iceCounts,
    fogCounts,
    flagLabel: observed ? '관측' : '분석'
  };
}

function matchStationRiskForCoord(lat, lon, stationRisks, frgRows, fogRows, radiusKm = 6) {
  let bestStn = null, bestDist = Infinity;
  for (const s of stationRisks || []) {
    const d = distanceKm(lat, lon, s.lat, s.lon);
    if (d < bestDist) { bestDist = d; bestStn = s; }
  }
  const localWin = frgRows?.length
    ? summarizeSegmentWindow(lat, lon, frgRows, fogRows, radiusKm)
    : { segmentCount: 0, iceLevel: 0, fogLevel: 0, iceCounts: [0, 0, 0, 0], fogCounts: [0, 0, 0, 0], flagLabel: '분석' };

  const iceLevel = Math.max(localWin.iceLevel || 0, bestStn?.iceLevel || 0);
  const fogLevel = Math.max(localWin.fogLevel || 0, bestStn?.fogLevel || 0);
  return {
    stationId: bestStn?.stnId || null,
    stationName: bestStn?.name || null,
    stationKm: bestStn?.km ?? null,
    stationType: bestStn?.stationType || null,
    stationDistanceKm: Number.isFinite(bestDist) ? Number(bestDist.toFixed(2)) : null,
    stationIceLevel: bestStn?.iceLevel ?? 0,
    stationIceLabel: ROAD_ICE_LABELS[bestStn?.iceLevel ?? 0],
    stationFogLevel: bestStn?.fogLevel ?? 0,
    stationFogLabel: ROAD_FOG_LABELS[bestStn?.fogLevel ?? 0],
    iceLevel,
    iceLabel: ROAD_ICE_LABELS[iceLevel] || '정보없음',
    fogLevel,
    fogLabel: ROAD_FOG_LABELS[fogLevel] || '안개없음',
    segmentCount: localWin.segmentCount || bestStn?.segmentCount || 0,
    iceCounts: localWin.iceCounts,
    fogCounts: localWin.fogCounts,
    flagLabel: localWin.flagLabel === '관측' || bestStn?.flagLabel === '관측' ? '관측' : '분석'
  };
}

function buildRoadRiskPayload({ roadNum = '012', tmUtc, tmKst, frgRows = [], fogRows = [] }) {
  const iceCounts = [0, 0, 0, 0];
  const fogCounts = [0, 0, 0, 0];
  const branchIceCounts = [0, 0, 0, 0];
  const branchFogCounts = [0, 0, 0, 0];
  let maxIce = 0, maxFog = 0, observedCount = 0;
  let branchMaxIce = 0, branchMaxFog = 0, branchTotal = 0;
  // 고령지사 관할 구간: 함양IC(133.2km, 127.72E) ~ 고령JC(213.4km, 128.45E)
  const inBranch = r => r.lon >= 127.71 && r.lon <= 128.45 && r.lat >= 35.48 && r.lat <= 35.80;

  for (const r of frgRows) {
    iceCounts[r.level] = (iceCounts[r.level] || 0) + 1;
    if (r.level > maxIce) maxIce = r.level;
    if (r.flag === 1) observedCount++;
    if (inBranch(r)) {
      branchTotal++;
      branchIceCounts[r.level] = (branchIceCounts[r.level] || 0) + 1;
      if (r.level > branchMaxIce) branchMaxIce = r.level;
    }
  }
  for (const r of fogRows) {
    fogCounts[r.level] = (fogCounts[r.level] || 0) + 1;
    if (r.level > maxFog) maxFog = r.level;
    if (inBranch(r)) {
      branchFogCounts[r.level] = (branchFogCounts[r.level] || 0) + 1;
      if (r.level > branchMaxFog) branchMaxFog = r.level;
    }
  }

  const stationRisks = CORRIDOR_ANCHOR_STATIONS.map(stn => {
    const win = summarizeSegmentWindow(stn.lat, stn.lon, frgRows, fogRows, 2.5);
    return {
      stnId: stn.stnId,
      name: stn.name,
      stationType: stn.stationType,
      km: stn.km,
      lat: stn.lat,
      lon: stn.lon,
      ...win
    };
  });

  const placeRisks = {};
  for (const p of CORRIDOR_WATCHED_PLACES) {
    const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    placeRisks[key] = {
      name: p.name,
      site: p.site,
      ...matchStationRiskForCoord(p.lat, p.lon, stationRisks, frgRows, fogRows, 6)
    };
  }

  return {
    ok: true,
    roadNum: String(roadNum).padStart(3, '0'),
    tmUtc,
    tmKst,
    updatedAt: new Date().toISOString(),
    corridorSummary: {
      total1km: frgRows.length,
      observedCount,
      maxIce,
      iceLabel: ROAD_ICE_LABELS[maxIce] || '정보없음',
      iceCounts,
      maxFog,
      fogLabel: ROAD_FOG_LABELS[maxFog] || '안개없음',
      fogCounts
    },
    branchSummary: {
      rangeLabel: '함양IC(133.2k)~고령JC(213.4k)',
      total1km: branchTotal,
      maxIce: branchMaxIce,
      iceLabel: ROAD_ICE_LABELS[branchMaxIce] || '정보없음',
      iceCounts: branchIceCounts,
      maxFog: branchMaxFog,
      fogLabel: ROAD_FOG_LABELS[branchMaxFog] || '안개없음',
      fogCounts: branchFogCounts
    },
    stationRisks,
    placeRisks
  };
}

/**
 * 13개 읍·면·동 통합 1시간 단기예보 모니터 (고령지사 관내·고속국도 12호선 연계)
 * - 기상청 날씨누리(weather.go.kr/w/rest/zone/dong.do) 공식 읍면동 대표 좌표 및 DFS 격자(nx, ny) 일치
 *   ※ 거창읍·남하면은 공식 KMA 격자 (77, 86)를 공유 → API 호출은 고유 12격자만 수행해 중복 호출 제거
 * - "경상목도 고령군 대가야면" 표기는 공식 행정명 "경상북도 고령군 대가야읍"으로 정정
 */
const SHORT_TERM_12_REGIONS = [
  { id: 'ssangnim', admin: '경북', county: '고령군', name: '쌍림면', group: '고령', color: '#4c84e8', routeOrder: 10, lat: 35.6768, lon: 128.2441 },
  { id: 'seongsan', admin: '경북', county: '고령군', name: '성산면', group: '고령', color: '#4c84e8', routeOrder: 12, lat: 35.7469, lon: 128.3621 },
  { id: 'daegaya', admin: '경북', county: '고령군', name: '대가야읍', group: '고령', color: '#4c84e8', routeOrder: 11, lat: 35.7305, lon: 128.2679 },
  { id: 'gaya', admin: '경남', county: '합천군', name: '가야면', group: '합천', color: '#9c6ade', routeOrder: 8, lat: 35.762683, lon: 128.139463 },
  { id: 'yaro', admin: '경남', county: '합천군', name: '야로면', group: '합천', color: '#9c6ade', routeOrder: 9, lat: 35.7022, lon: 128.1699 },
  { id: 'geochang', admin: '경남', county: '거창군', name: '거창읍', group: '거창', color: '#d98a36', routeOrder: 4, lat: 35.6849, lon: 127.9060 },
  { id: 'namha', admin: '경남', county: '거창군', name: '남하면', group: '거창', color: '#d98a36', routeOrder: 6, lat: 35.6647, lon: 127.9458 },
  { id: 'namsang', admin: '경남', county: '거창군', name: '남상면', group: '거창', color: '#d98a36', routeOrder: 5, lat: 35.6402, lon: 127.9122 },
  { id: 'gajo', admin: '경남', county: '거창군', name: '가조면', group: '거창', color: '#d98a36', routeOrder: 7, lat: 35.7080, lon: 128.0169 },
  { id: 'sudong', admin: '경남', county: '함양군', name: '수동면', group: '함양', color: '#2ea87e', routeOrder: 3, lat: 35.5191, lon: 127.7899 },
  { id: 'jigok', admin: '경남', county: '함양군', name: '지곡면', group: '함양', color: '#2ea87e', routeOrder: 2, lat: 35.5632, lon: 127.7764 },
  { id: 'hamyang', admin: '경남', county: '함양군', name: '함양읍', group: '함양', color: '#2ea87e', routeOrder: 1, lat: 35.5166, lon: 127.7288 },
  { id: 'okpo', admin: '대구', county: '달성군', name: '옥포읍', group: '달성', color: '#c47b50', routeOrder: 13, lat: 35.7866, lon: 128.4660 }
].map(r => ({ ...r, grid: latlonToGrid(r.lat, r.lon) }));

function summarizeHourlyWindow(hours = []) {
  let wetHours = 0, firstWetTime = null;
  let freezingHours = 0, firstFreezingTime = null;
  let overlapHours = 0, firstOverlapTime = null;
  let minTemp = null, maxTemp = null, maxPop = 0, totalRainMm = 0, maxSnowCm = 0, maxWind = 0;

  for (const h of hours) {
    const t = h.temp != null && Number.isFinite(Number(h.temp)) ? Number(h.temp) : null;
    const pop = h.pop != null && Number.isFinite(Number(h.pop)) ? Number(h.pop) : 0;
    const isWet = !!h.wet;
    const isSubzero = t !== null && t < 0;

    if (isWet) {
      wetHours++;
      if (!firstWetTime) firstWetTime = h.time;
    }
    if (isSubzero) {
      freezingHours++;
      if (!firstFreezingTime) firstFreezingTime = h.time;
    }
    if (isWet && isSubzero) {
      overlapHours++;
      if (!firstOverlapTime) firstOverlapTime = h.time;
    }
    if (t !== null) {
      minTemp = minTemp === null ? t : Math.min(minTemp, t);
      maxTemp = maxTemp === null ? t : Math.max(maxTemp, t);
    }
    if (pop > maxPop) maxPop = pop;
    if (Number.isFinite(h.rainMm)) totalRainMm += h.rainMm;
    if (Number.isFinite(h.snowCm) && h.snowCm > maxSnowCm) maxSnowCm = h.snowCm;
    if (Number.isFinite(h.wind) && h.wind > maxWind) maxWind = h.wind;
  }

  return {
    hoursCount: hours.length,
    wetHours,
    firstWetTime,
    freezingHours,
    firstFreezingTime,
    overlapHours,
    firstOverlapTime,
    minTemp,
    maxTemp,
    maxPop,
    totalRainMm: Math.round(totalRainMm * 10) / 10,
    maxSnowCm: Math.round(maxSnowCm * 10) / 10,
    maxWind: Math.round(maxWind * 10) / 10
  };
}

function buildShortTermRegionForecast({ region, now = Date.now(), shortRes = null, ultraRes = null, forceStartK = null }) {
  const near = grouped(ultraRes?.items);
  const far = grouped(shortRes?.items);
  const nowK = kst(now);
  nowK.setUTCMinutes(0, 0, 0);
  const todayDayNum = nowK.getUTCDate();

  // 초단기예보(+1h~+6h)가 이미 다음 정각(+1h)을 시작 시각으로 제공하면 기상청 단기예보 페이지처럼 그 시각부터 시작해
  // 지나간 현재 정각의 구형 단기예보(02시 등)와 초단기예보 사이의 인위적 기온/하늘 단차를 방지한다.
  const nextHourKey = datePart(new Date(nowK.getTime() + 3600000)) + timePart(new Date(nowK.getTime() + 3600000));
  const nowHourKey = datePart(nowK) + timePart(nowK);
  const startK = forceStartK instanceof Date
    ? forceStartK
    : (!near.has(nowHourKey) && near.has(nextHourKey))
      ? new Date(nowK.getTime() + 3600000)
      : nowK;

  // 시작 시각 ~ 내일 23:00 KST 범위 (최소 24시간, 최대 48시간)
  const targetHours = Math.max(24, Math.min(48, (24 - startK.getUTCHours()) + 24));
  const hours = [];

  for (let i = 0; i < targetHours; i++) {
    const d = new Date(startK.getTime() + i * 3600000);
    const key = datePart(d) + timePart(d);
    const sourceNear = near.get(key);
    const sourceFar = far.get(key);
    if (!sourceNear && !sourceFar) continue;
    const combined = { ...(sourceFar || {}), ...(sourceNear || {}), __source: sourceNear ? '초단기+단기' : '단기예보' };
    const c = classify(combined);
    const hKst = d.getUTCHours();
    const dNum = d.getUTCDate();
    hours.push({
      offset: hours.length,
      time: isoKst(d),
      dateLabel: `${pad(d.getUTCMonth() + 1)}-${pad(dNum)}`,
      dayNum: dNum,
      isTomorrow: dNum !== todayDayNum,
      hourKst: hKst,
      isNight: hKst >= 18 || hKst < 6,
      temp: c.temp != null && Number.isFinite(Number(c.temp)) ? Number(c.temp) : null,
      humidity: c.humidity != null && Number.isFinite(Number(c.humidity)) ? Number(c.humidity) : null,
      pop: c.chance,
      pty: c.pty,
      lightning: !!c.lightning,
      sky: c.sky,
      skyLabel: c.skyLabel,
      type: c.type,
      wet: c.wet,
      rainMm: c.rainMm,
      snowCm: c.snowCm,
      amount: c.amount,
      snow: c.snow,
      wind: c.wind,
      vec: c.vec,
      windDir: c.windDir,
      source: c.source
    });
  }

  return {
    id: region.id,
    admin: region.admin,
    county: region.county,
    name: region.name,
    group: region.group,
    color: region.color,
    routeOrder: region.routeOrder,
    lat: region.lat,
    lon: region.lon,
    grid: region.grid,
    sources: {
      short: shortRes?.base || null,
      ultra: ultraRes?.base || null
    },
    hours,
    summaries: {
      h6: summarizeHourlyWindow(hours.slice(0, 6)),
      h12: summarizeHourlyWindow(hours.slice(0, 12)),
      h24: summarizeHourlyWindow(hours.slice(0, 24)),
      tomorrow: summarizeHourlyWindow(hours)
    }
  };
}

function buildShortTerm12Payload({ now = Date.now(), regionResults = [] }) {
  const gridGroups = new Map();
  for (const r of regionResults) {
    const gk = `${r.grid.nx},${r.grid.ny}`;
    if (!gridGroups.has(gk)) gridGroups.set(gk, []);
    gridGroups.get(gk).push(`${r.county} ${r.name}`);
  }
  const regions = regionResults.map(r => {
    const gk = `${r.grid.nx},${r.grid.ny}`;
    const peers = (gridGroups.get(gk) || []).filter(n => n !== `${r.county} ${r.name}`);
    return { ...r, sharedGridRegions: peers };
  });

  const kpiFor = (key) => {
    let wetRegions = 0, freezingRegions = 0, overlapRegions = 0;
    let earliestWetTime = null, earliestFreezingTime = null, earliestOverlapTime = null;
    let minTemp = null;
    for (const r of regions) {
      const s = r.summaries?.[key];
      if (!s) continue;
      if (s.wetHours > 0) {
        wetRegions++;
        if (!earliestWetTime || (s.firstWetTime && s.firstWetTime < earliestWetTime)) earliestWetTime = s.firstWetTime;
      }
      if (s.freezingHours > 0) {
        freezingRegions++;
        if (!earliestFreezingTime || (s.firstFreezingTime && s.firstFreezingTime < earliestFreezingTime)) earliestFreezingTime = s.firstFreezingTime;
      }
      if (s.overlapHours > 0) {
        overlapRegions++;
        if (!earliestOverlapTime || (s.firstOverlapTime && s.firstOverlapTime < earliestOverlapTime)) earliestOverlapTime = s.firstOverlapTime;
      }
      if (s.minTemp !== null) minTemp = minTemp === null ? s.minTemp : Math.min(minTemp, s.minTemp);
    }
    return {
      wetRegions,
      freezingRegions,
      overlapRegions,
      earliestWetTime,
      earliestFreezingTime,
      earliestOverlapTime,
      minTemp
    };
  };

  const firstShort = regions.find(r => r.sources?.short)?.sources?.short || null;
  const firstUltra = regions.find(r => r.sources?.ultra)?.sources?.ultra || null;

  return {
    ok: true,
    mode: 'short-term-12',
    updatedAt: new Date(now).toISOString(),
    uniqueGridCount: gridGroups.size,
    sources: { shortBase: firstShort, ultraBase: firstUltra },
    windowKPIs: {
      h6: kpiFor('h6'),
      h12: kpiFor('h12'),
      h24: kpiFor('h24'),
      tomorrow: kpiFor('tomorrow')
    },
    regions
  };
}

async function collectShortTerm12({ now = Date.now(), fetchShort, fetchUltra }) {
  // 13개 읍·면·동을 고유 격자(nx, ny) 기준으로 중복 제거(거창읍·남하면 공유 → 12개 고유 격자)해 KMA 호출량을 최소화
  const uniqueGrids = new Map();
  for (const r of SHORT_TERM_12_REGIONS) {
    const gk = `${r.grid.nx},${r.grid.ny}`;
    if (!uniqueGrids.has(gk)) uniqueGrids.set(gk, r.grid);
  }
  const gridEntries = [...uniqueGrids.entries()];
  const gridData = new Map();
  // Cloudflare Workers 동시 아웃바운드 6연결 한도를 넘겨 대기 중 타임아웃이 연쇄 발생하지 않도록 격자 3개(=최대 6요청)씩 분할
  const chunkSize = 3;
  for (let idx = 0; idx < gridEntries.length; idx += chunkSize) {
    const batch = gridEntries.slice(idx, idx + chunkSize);
    const settled = await Promise.allSettled(
      batch.map(async ([gk, grid]) => {
        const [shortSettled, ultraSettled] = await Promise.allSettled([
          fetchShort(grid),
          fetchUltra ? fetchUltra(grid) : Promise.resolve(null)
        ]);
        const shortRes = shortSettled.status === 'fulfilled' ? shortSettled.value : null;
        const ultraRes = ultraSettled.status === 'fulfilled' ? ultraSettled.value : null;
        if (!shortRes && !ultraRes) {
          throw shortSettled.reason || new Error(`격자(${gk}) 단기예보 조회 실패`);
        }
        return { gk, shortRes, ultraRes };
      })
    );
    for (let j = 0; j < settled.length; j++) {
      const [gk] = batch[j];
      if (settled[j].status === 'fulfilled') {
        gridData.set(gk, settled[j].value);
      } else {
        gridData.set(gk, { gk, shortRes: null, ultraRes: null });
      }
    }
  }

  // 1회 병렬 조회 중 일시 누락된 격자(단기 또는 초단기 null)만 최대 1회 보완 재시도
  const retryEntries = gridEntries.filter(([gk]) => {
    const e = gridData.get(gk);
    return !e?.shortRes || (fetchUltra && !e?.ultraRes);
  });
  for (let idx = 0; idx < retryEntries.length; idx += 3) {
    const batch = retryEntries.slice(idx, idx + 3);
    await Promise.allSettled(
      batch.map(async ([gk, grid]) => {
        const cur = gridData.get(gk) || { gk, shortRes: null, ultraRes: null };
        const [sTry, uTry] = await Promise.allSettled([
          !cur.shortRes ? fetchShort(grid) : Promise.resolve(cur.shortRes),
          (fetchUltra && !cur.ultraRes) ? fetchUltra(grid) : Promise.resolve(cur.ultraRes)
        ]);
        gridData.set(gk, {
          gk,
          shortRes: sTry.status === 'fulfilled' ? sTry.value : cur.shortRes,
          ultraRes: uTry.status === 'fulfilled' ? uTry.value : cur.ultraRes
        });
      })
    );
  }

  // 다른 격자들 중 하나라도 +1h 초단기 예보가 시작되어 있다면 전체 지역의 기준 시작 시각을 동일하게 맞춰 1시간 열 어긋남 방지
  const nowK = kst(now);
  nowK.setUTCMinutes(0, 0, 0);
  const nextHourKey = datePart(new Date(nowK.getTime() + 3600000)) + timePart(new Date(nowK.getTime() + 3600000));
  const nowHourKey = datePart(nowK) + timePart(nowK);
  const useNextHourStart = [...gridData.values()].some(e => {
    if (!e?.ultraRes?.items?.length) return false;
    const n = grouped(e.ultraRes.items);
    return !n.has(nowHourKey) && n.has(nextHourKey);
  });
  const uniformStartK = useNextHourStart ? new Date(nowK.getTime() + 3600000) : nowK;

  const results = SHORT_TERM_12_REGIONS.map((region) => {
    const gk = `${region.grid.nx},${region.grid.ny}`;
    const entry = gridData.get(gk) || { shortRes: null, ultraRes: null };
    return buildShortTermRegionForecast({ region, now, shortRes: entry.shortRes, ultraRes: entry.ultraRes, forceStartK: uniformStartK });
  });
  if (!results.some(r => r.hours.length > 0)) {
    throw new Error('관심지역 기상청 단기예보를 불러오지 못했습니다. API 키 승인 상태를 확인하세요.');
  }
  return buildShortTerm12Payload({ now, regionResults: results });
}

function parseOverviewPlacesParam(rawPlaces = '') {
  const s = String(rawPlaces || '').trim();
  if (!s) {
    return CORRIDOR_WATCHED_PLACES.map(p => ({
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      key: `${Number(p.lat).toFixed(3)},${Number(p.lon).toFixed(3)}`,
      grid: latlonToGrid(p.lat, p.lon)
    }));
  }
  const out = [];
  const seen = new Set();
  for (const part of s.split(';')) {
    if (out.length >= 10) break;
    const chunks = part.split('|');
    const coordStr = chunks.length >= 2 ? chunks.slice(-1)[0] : chunks[0];
    const name = chunks.length >= 2 ? chunks.slice(0, -1).join('|').trim().slice(0, 40) : '';
    const [latRaw, lonRaw] = String(coordStr || '').split(',');
    const lat = Number(latRaw), lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 32 || lat > 39.5 || lon < 124 || lon > 132) continue;
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name || key, lat, lon, key, grid: latlonToGrid(lat, lon) });
  }
  return out;
}

function canonicalOverviewPlacesKey(places = []) {
  return [...(places || [])]
    .filter(p => p && p.key)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map(p => `${p.name || p.key}|${p.key}`)
    .join(';');
}


/**
 * 광주대구선(남원~대구) 고속도로 CCTV 목록 조회 및 19개 지점 매칭 모듈
 * - 국토교통부 국가교통정보센터(ITS) Open API (https://openapi.its.go.kr:9443/cctvInfo)
 * - 선택 환경변수 CCTV_SOURCE_URL 지정 시 해당 URL에서 동일 형식의 JSON을 받아옵니다.
 */

const CCTV_CACHE_TTL_SECONDS = 900; // 15분
const CCTV_UPSTREAM_TIMEOUT_MS = 10000;
const CCTV_ITS_ENDPOINT = 'https://openapi.its.go.kr:9443/cctvInfo';

// 남원 127.39°E ~ 대구 논공 128.45°E, 35.38°N ~ 35.80°N 전체 커버
const CCTV_BOUNDS = {
  minX: 127.25,
  maxX: 128.65,
  minY: 35.3,
  maxY: 35.9
};

/**
 * 19개 지점(관심지역 8 + 도로관측소 11) → 최인접/보조 CCTV 이름 매핑
 */
const CCTV_SITES = [
  // ── 관심지역 (8) ─────────────────────────────────────────────
  {
    id: 'dalseong-nambu',
    group: 'interest',
    name: '대구 달성군남부',
    sub: '현풍읍',
    nearest: { label: '논공교2', km: 8.09, note: '종점부' },
    aux: [{ label: '논공교3' }, { label: '논공휴게소' }]
  },
  {
    id: 'hamyang-jungbu',
    group: 'interest',
    name: '함양중부',
    sub: '지곡면',
    nearest: { label: '우명교', km: 2.68 },
    aux: [{ label: '원평교' }, { label: '죽산천교1' }]
  },
  {
    id: 'geochang-nambu',
    group: 'interest',
    name: '거창군남부',
    sub: '남상면',
    nearest: { label: '무촌2교', km: 0.56 },
    aux: [{ label: '송변교' }, { label: '오계교' }]
  },
  {
    id: 'hapcheon-seobuk',
    group: 'interest',
    name: '합천군서북부',
    sub: '야로면',
    nearest: { label: '야로대교1', km: 1.46 },
    aux: [{ label: '야로대교2' }, { label: '해인사' }]
  },
  {
    id: 'goryeong',
    group: 'interest',
    name: '고령군',
    sub: '대가야읍',
    nearest: { label: '안림천교', km: 2.29 },
    aux: [{ label: '회천대교' }, { label: '양전교' }]
  },
  {
    id: 'namwon',
    group: 'interest',
    name: '남원',
    sub: '남원시청',
    nearest: { label: '남원', km: 1.59 },
    aux: [{ label: '산곡' }, { label: '남원휴게소' }]
  },
  {
    id: 'hamyang-eup',
    group: 'interest',
    name: '함양',
    sub: '함양읍',
    nearest: { label: '교산', km: 1.8 },
    aux: [{ label: '두산' }, { label: '함양' }]
  },
  {
    id: 'geochang-eup',
    group: 'interest',
    name: '거창',
    sub: '거창읍',
    nearest: { label: '정장교', km: 2.29 },
    aux: [{ label: '거창' }, { label: '무촌2교' }]
  },

  // ── 도로관측소 (11) ──────────────────────────────────────────
  {
    id: '14205',
    group: 'observatory',
    code: '14205',
    name: '남원주차장(도)',
    sub: '50.8k',
    nearest: { label: '남원휴게소', km: 0.13 },
    aux: [{ label: '생태터널' }, { label: '남원' }]
  },
  {
    id: '14407',
    group: 'observatory',
    code: '14407',
    name: '번암교(도)',
    sub: '72.9k',
    tag: '목표·결빙',
    nearest: { label: '번암교', km: 0.04 },
    aux: [{ label: '번암1터널' }, { label: '지리산휴게소' }]
  },
  {
    id: '14102',
    group: 'observatory',
    code: '14102',
    name: '지리산휴(도)',
    sub: '75.4k',
    tag: '거점',
    nearest: { label: '지리산휴게소', km: 0.5 },
    aux: [{ label: '당동' }, { label: '번암교' }]
  },
  {
    id: '14408',
    group: 'observatory',
    code: '14408',
    name: '옥계1교(도)',
    sub: '86.2k',
    tag: '목표·결빙',
    nearest: { label: '옥계1교', km: 0.04 },
    aux: [{ label: '백전교' }]
  },
  {
    id: '14206',
    group: 'observatory',
    code: '14206',
    name: '함양(도)',
    sub: '95.0k',
    nearest: { label: '함양', km: 0.08 },
    aux: [{ label: '두산' }, { label: '교산' }]
  },
  {
    id: '14409',
    group: 'observatory',
    code: '14409',
    name: '죽산천교(도)',
    sub: '102.9k',
    tag: '목표·결빙',
    nearest: { label: '죽산천교1', km: 0.13 },
    aux: [{ label: '죽산교' }]
  },
  {
    id: '14207',
    group: 'observatory',
    code: '14207',
    name: '남상졸음(도)',
    sub: '115.3k',
    nearest: { label: '오계교', km: 0.75 },
    aux: [{ label: '무촌2교' }]
  },
  {
    id: '14208',
    group: 'observatory',
    code: '14208',
    name: '거창휴(도)',
    sub: '134.1k',
    nearest: { label: '거창휴게소', km: 0.19 },
    aux: [{ label: '가조터널', note: '외부대구' }]
  },
  {
    id: '14209',
    group: 'observatory',
    code: '14209',
    name: '양전교(도)',
    sub: '158.2k',
    nearest: { label: '양전교', km: 0.32 },
    aux: [{ label: '양전리2' }, { label: '안림천교' }]
  },
  {
    id: '14103',
    group: 'observatory',
    code: '14103',
    name: '논공휴(도)',
    sub: '169.2k',
    tag: '거점',
    nearest: { label: '논공휴게소', km: 0.16 },
    aux: [{ label: '논공휴게소2' }]
  },
  {
    id: '14410',
    group: 'observatory',
    code: '14410',
    name: '논공교(도)',
    sub: '171.3k',
    tag: '목표·결빙',
    nearest: { label: '논공교2', km: 0.3 },
    aux: [{ label: '논공교3' }, { label: '논공휴게소' }]
  }
];

function cctvUpstreamError(code, message, detail = {}) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail;
  return err;
}

function cctvFirstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function cctvToNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** CCTV 이름 비교용 정규화: 괄호 주석·공백 제거, 소문자 */
function normalizeCctvName(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * ITS 응답의 다양한 item 배열 위치를 재귀적으로 탐색합니다.
 */
function findCctvArray(node, depth = 0) {
  const looksLikeCctv = (item) =>
    item &&
    typeof item === 'object' &&
    (cctvFirstString(item, ['cctvurl', 'cctvUrl']) || (item.url && (item.name || item.cctvname)));

  if (Array.isArray(node)) {
    if (node.some(looksLikeCctv)) return node;
    return null;
  }
  if (!node || typeof node !== 'object' || depth > 6) return null;

  for (const key of ['item', 'items', 'data', 'list', 'body', 'response']) {
    if (key in node) {
      const found = findCctvArray(node[key], depth + 1);
      if (found) return found;
    }
  }
  for (const value of Object.values(node)) {
    const found = findCctvArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function readItsResultHeader(json) {
  const header = json && json.response && json.response.header;
  if (!header) return null;
  return {
    code: cctvFirstString(header, ['resultCode', 'resultcode', 'code']),
    message: cctvFirstString(header, ['resultMsg', 'resultmsg', 'message'])
  };
}

function upgradeKnownHttpsStreamUrl(url) {
  return String(url || '').replace(/^http:\/\/(cctvsec\.ktict\.co\.kr\/)/i, 'https://$1');
}

function normalizeCctvItem(item) {
  const rawUrl = cctvFirstString(item, ['cctvurl', 'cctvUrl', 'url']);
  if (!rawUrl) return null;
  const url = upgradeKnownHttpsStreamUrl(rawUrl);
  const name = cctvFirstString(item, ['cctvname', 'cctvName', 'name']);
  const format = cctvFirstString(item, ['cctvformat', 'cctvFormat', 'format']);
  const x = cctvToNumber(cctvFirstString(item, ['coordx', 'coordX', 'x']));
  const y = cctvToNumber(cctvFirstString(item, ['coordy', 'coordY', 'y']));
  const label = name || '(이름 없음)';
  return {
    id: cctvFirstString(item, ['cctvid', 'cctvId', 'id']) || [label, y, x].join('|'),
    name: label,
    url,
    format: format || (url.includes('.m3u8') ? 'HLS' : 'MP4'),
    x,
    y
  };
}

/** 이름 하나로 후보를 찾습니다: 정확 일치 → 부분 일치 */
function matchCctvLabel(label, cctvs) {
  const target = normalizeCctvName(label);
  if (!target) return { label, mode: 'none', items: [] };

  const exact = cctvs.filter((c) => normalizeCctvName(c.name) === target);
  if (exact.length) return { label, mode: 'exact', items: exact };

  const containsTarget = cctvs.filter((c) => normalizeCctvName(c.name).includes(target));
  if (containsTarget.length) return { label, mode: 'partial', items: containsTarget };

  const targetContainsName = cctvs.filter((c) => {
    const name = normalizeCctvName(c.name);
    return name.length >= 2 && target.includes(name);
  });
  if (targetContainsName.length) return { label, mode: 'partial', items: targetContainsName };

  return { label, mode: 'none', items: [] };
}

function buildCctvSites(cctvs) {
  let labelCount = 0;
  let matchedCount = 0;
  const unmatchedLabels = [];

  const sites = CCTV_SITES.map((site) => {
    const nearest = { ...site.nearest, ...matchCctvLabel(site.nearest.label, cctvs) };
    const aux = site.aux.map((entry) => ({ ...entry, ...matchCctvLabel(entry.label, cctvs) }));

    for (const entry of [nearest, ...aux]) {
      labelCount += 1;
      if (entry.items.length) matchedCount += 1;
      else unmatchedLabels.push(entry.label);
    }

    return {
      id: site.id,
      group: site.group,
      code: site.code || null,
      name: site.name,
      sub: site.sub || '',
      tag: site.tag || null,
      nearest: {
        label: nearest.label,
        km: nearest.km != null ? nearest.km : null,
        note: nearest.note || null,
        mode: nearest.mode,
        count: nearest.items.length,
        items: nearest.items
      },
      aux: aux.map((entry) => ({
        label: entry.label,
        note: entry.note || null,
        mode: entry.mode,
        count: entry.items.length,
        items: entry.items
      }))
    };
  });

  return {
    sites,
    stats: {
      sites: CCTV_SITES.length,
      labels: labelCount,
      matchedLabels: matchedCount,
      unmatchedLabels
    }
  };
}

function buildItsCctvUrl(apiKey) {
  const url = new URL(CCTV_ITS_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('type', 'ex');
  url.searchParams.set('cctvType', '1');
  url.searchParams.set('minX', String(CCTV_BOUNDS.minX));
  url.searchParams.set('maxX', String(CCTV_BOUNDS.maxX));
  url.searchParams.set('minY', String(CCTV_BOUNDS.minY));
  url.searchParams.set('maxY', String(CCTV_BOUNDS.maxY));
  url.searchParams.set('getType', 'json');
  return url.toString();
}

function isCctvConfigured(env = {}) {
  return Boolean(String(env.ITS_API_KEY || '').trim() || String(env.CCTV_SOURCE_URL || '').trim());
}

async function fetchItsCctvJson(env = {}, fetchImpl = fetch) {
  const customSource = String(env.CCTV_SOURCE_URL || '').trim();
  const apiKey = String(env.ITS_API_KEY || '').trim();

  if (!customSource && !apiKey) {
    throw cctvUpstreamError('ITS_API_KEY_MISSING', 'ITS_API_KEY 시크릿이 설정되지 않았습니다.', {
      howTo: [
        '배포: wrangler secret put ITS_API_KEY  (발급받은 키 붙여넣기)',
        '로컬: 프로젝트 루트 .dev.vars 또는 .env 파일에 ITS_API_KEY=발급받은키 추가',
        '이 키는 코드에 하드코딩하지 마세요. 저장소에 커밋되면 즉시 노출됩니다.'
      ]
    });
  }

  const sourceUrl = customSource || buildItsCctvUrl(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CCTV_UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetchImpl(sourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw cctvUpstreamError('UPSTREAM_HTTP_ERROR', `업스트림이 HTTP ${res.status}로 응답했습니다.`, {
        status: res.status,
        sample: body.slice(0, 300)
      });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw cctvUpstreamError('UPSTREAM_BAD_JSON', '업스트림 응답을 JSON으로 해석하지 못했습니다.', {
        sample: text.slice(0, 200)
      });
    }

    return { json, source: customSource ? 'custom' : 'its' };
  } catch (err) {
    if (err && err.detail) throw err;
    const aborted = controller.signal.aborted || (err && err.name === 'AbortError');
    throw cctvUpstreamError(
      aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      aborted
        ? `업스트림 응답이 ${CCTV_UPSTREAM_TIMEOUT_MS / 1000}초 안에 오지 않았습니다.`
        : '업스트림에 연결하지 못했습니다.',
      { cause: String((err && err.message) || err) }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readCctvPayload(env, fetchImpl) {
  const { json, source } = await fetchItsCctvJson(env, fetchImpl);

  const rawItems = findCctvArray(json) || [];
  const cctvs = [];
  const seen = new Set();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const cctv = normalizeCctvItem(item);
    if (!cctv) continue;
    const key = `${cctv.name}|${cctv.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cctvs.push(cctv);
  }

  if (cctvs.length === 0) {
    const header = readItsResultHeader(json);
    if (header && header.code && !['0', '00', '000', 'SUCCESS'].includes(header.code.toUpperCase())) {
      throw cctvUpstreamError('ITS_API_ERROR', `ITS API가 오류를 반환했습니다. (${header.code})`, {
        resultCode: header.code,
        resultMsg: header.message
      });
    }
  }

  cctvs.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const { sites, stats } = buildCctvSites(cctvs);

  return {
    ok: true,
    source: source === 'its' ? 'ITS 국가교통정보센터 Open API' : 'CCTV_SOURCE_URL',
    bounds: CCTV_BOUNDS,
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CCTV_CACHE_TTL_SECONDS,
    count: cctvs.length,
    cctvs,
    sites,
    stats
  };
}

async function buildCctvPayload(env = {}, fetchImpl = fetch) {
  if (!String(env.CCTV_SOURCE_URL || '').trim() || !String(env.ITS_API_KEY || '').trim()) {
    return readCctvPayload(env, fetchImpl);
  }
  try {
    const mirror = await readCctvPayload(env, fetchImpl);
    if (mirror.count) return mirror;
  } catch {
    // An unavailable mirror must not disable the configured ITS feed.
  }
  return readCctvPayload({ ...env, CCTV_SOURCE_URL: '' }, fetchImpl);
}


/**
 * 비온다? × 날씨봇 — Cloudflare Workers 무료 티어(24시간 무슬립·일 10만 요청) API 프록시
 * - 비밀 인증키(KMA_SERVICE_KEY 등)는 Cloudflare Workers Secrets(환경변수)에만 보관합니다.
 * - GitHub Pages(poeticecho.github.io) 프론트엔드에서 CORS로 직접 호출해 5분 실시간 갱신을 수행합니다.
 */
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
        setCached(staleKey, { items, base: isoKst(base) }, staleTtlMs);
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
          probePromise = fetchWithFallback(env, 'getUltraSrtFcst', grid, uBase, 60, refreshUltra).then(res => {
            resolvedUBase = res.notice ? new Date(uBase.getTime() - 60 * 60000) : uBase;
            return { firstKey: `${grid.nx},${grid.ny}`, res };
          });
        }
        const probed = await probePromise;
        if (probed.firstKey === `${grid.nx},${grid.ny}`) return probed.res;
      }
      const activeBase = resolvedUBase || uBase;
      return { items: await fetchKma(env, 'getUltraSrtFcst', grid, activeBase, 6000, refreshUltra), base: isoKst(activeBase) };
    };

    const payload = await collectShortTerm12({
      now,
      fetchShort: (grid) => fetchWithFallback(env, 'getVilageFcst', grid, sBase, 180, refreshShort),
      fetchUltra: fetchUltraSmart
    });
    const pendingUltra = resolvedUBase && resolvedUBase.getTime() < uBase.getTime();
    setCached(cacheKey, payload, pendingUltra ? 45000 : 5 * 60000);
    return payload;
  });
}

async function fetchRoadStations(env, line = getRoadLineCode(env), bypassCache = false) {
  const key = getRoadKey(env);
  if (!key) throw new Error('KMA_ROAD_KEY 또는 KMA_SERVICE_KEY 미설정');
  const cacheKey = `road-obs|${line}`;
  const staleKey = `road-obs-last-good|${line}`;
  const hit = !bypassCache ? getCached(cacheKey) : null;
  if (hit) return hit;

  return withInFlight(bypassCache ? `${cacheKey}|bypass` : cacheKey, async () => {
    const now = Date.now();
    const offsetsMinutes = [2, 6];
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
        const r = await fetchWithTimeout(u.toString(), {}, 4000);
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
    const offsetsMinutes = [5, 10, 15];
    for (const off of offsetsMinutes) {
      try {
        const { tmUtc, tmKst } = utcFiveMinSlot(now - off * 60000);
        const u = new URL('https://apihub.kma.go.kr/api/typ04/url/road_file_down.php');
        u.searchParams.set('tm', tmUtc);
        u.searchParams.set('roadNum', cleanNum);
        u.searchParams.set('authKey', deEncodedKey(key));
        const r = await fetchWithTimeout(u.toString(), {}, 4000);
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
  const bundleKey = `bundle|${line}|${roadNum}|${canonicalOverviewPlacesKey(places)}|${timePart(uBase)}|${timePart(sBase)}`;
  const hit = !force ? getCached(bundleKey) : null;
  if (hit) return hit;

  return withInFlight(force ? `${bundleKey}|force` : bundleKey, async () => {
    const uniqueGrids = new Map();
    for (const p of places) {
      const gk = `${p.grid.nx},${p.grid.ny}`;
      if (!uniqueGrids.has(gk)) uniqueGrids.set(gk, p.grid);
    }
    const gridEntries = [...uniqueGrids.entries()];

    // 1) 도로관측 · 012위험 · 특보 · 첫 번째 격자(ultra probe) 병렬 시작 후 나머지 격자는 2개씩 분할 (Cloudflare 6연결 한도 내 타임아웃 방지)
    const roadPromise = getRoadKey(env) ? fetchRoadStations(env, line, force).catch(() => null) : Promise.resolve(null);
    const riskPromise = getRoadKey(env) ? fetchRoadRisk(env, roadNum).catch(() => null) : Promise.resolve(null);
    const wrnPromise = fetchWrnNowList(env).catch(() => null);

    const gridResults = new Map();
    let forecastPromise = Promise.resolve();
    if (getServiceKey(env) && gridEntries.length) {
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
          gridNeedsNcst.has(gk) ? fetchWithFallback(env, 'getUltraSrtNcst', grid, oBase, 60) : null
        );
        const requests = await Promise.allSettled([
          fetchBundleUltra(grid),
          fetchWithFallback(env, 'getVilageFcst', grid, sBase, 180),
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
    const capPolyMap = hasSubZones ? await getCapPolygonMap() : new Map();

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
      const refresh = requestUrl.searchParams.get('refresh') === '1' || requestUrl.searchParams.get('refresh') === 'true';
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

    // Check Edge Cache API (normalized radar key unless force / refreshShort / refreshUltra)
    const isForced = requestUrl.searchParams.get('force') === '1';
    const bypassEdge = isForced || requestUrl.searchParams.get('refreshShort') === '1' || requestUrl.searchParams.get('refreshUltra') === '1';
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
        const rsParam = requestUrl.searchParams.get('refreshShort');
        const ruParam = requestUrl.searchParams.get('refreshUltra');
        const refreshShort = rsParam !== null ? rsParam === '1' : isForced;
        const refreshUltra = ruParam !== null ? ruParam === '1' : isForced;
        const value = await fetchShortTerm12(env, { force: isForced, refreshShort, refreshUltra });
        const nowMs = Date.now();
        const kstMin = kst(nowMs).getUTCMinutes();
        const secsToHour = Math.max(5, Math.ceil((3600000 - (nowMs % 3600000)) / 1000));
        // 35분(HH:35:00) 경계에 KMA 새 초단기예보가 열리므로 Edge/Browser 캐시가 35분을 넘기지 않도록 제한
        const minsPast35 = kstMin < 35 ? (35 - kstMin) * 60 : 3600;
        const expectedUltraIso = isoKst(baseUltra(nowMs));
        const pendingUltraRelease = value?.sources?.ultraBase && Date.parse(value.sources.ultraBase) < Date.parse(expectedUltraIso);
        const capSec = pendingUltraRelease ? 45 : 300;
        const maxAge = Math.min(180, secsToHour, minsPast35, capSec);
        const sMaxAge = Math.min(300, secsToHour, minsPast35, capSec);
        const bypassAllCache = isForced || refreshShort || refreshUltra;
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
        const all = await fetchWrnNowList(env);
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
          const res = jsonResponse(
            request,
            env,
            200,
            { ok: true, mode: 'batch', warningsConfirmed: Boolean(getServiceKey(env)) && !isStale, updatedAt: new Date().toISOString(), stale: isStale, items, totalNational: all.length },
            { 'Cache-Control': cacheCtrl }
          );
          if (!isStale) putEdgeCache(ctx, cacheKeyReq, res);
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
        if (!isStale) putEdgeCache(ctx, cacheKeyReq, res);
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
