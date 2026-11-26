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
  // KMA 단기예보(02·05·08·11·14·17·20·23시)는 매 발표시각 +10분경 API 개방되므로
  // 11분 안전 지연 후 즉시 조회를 시작하고, 미개방 시 호출부 fallback + 45초 단기 캐시로 신속 전환한다.
  const d = kst(now - 11 * 60000);
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
    source: hour.__source || '단기예보',
    popSource: hour.__popSource || null
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

// Both the point forecast and comparison matrix use the same KMA release window.
function forecastWindowStart(now) {
  const start = baseUltra(now);
  start.setUTCHours(start.getUTCHours() + 1, 0, 0, 0);
  return start;
}

function forecastHour(near, far, start, index) {
  const date = new Date(start.getTime() + index * 3600000);
  const key = datePart(date) + timePart(date);
  const ultra = index < 6 ? near.get(key) : null;
  const short = far.get(key);
  if (!ultra && !short) return null;
  // KMA 초단기예보(getUltraSrtFcst)는 POP(강수확률)·SNO(신적설) 항목이 없으므로 동일 시각 단기예보 값을 보완하되 출처를 명시한다.
  const popFromShort = Boolean(ultra && ultra.POP == null && short?.POP != null);
  const values = {
    ...short,
    ...ultra,
    __source: ultra ? '초단기예보' : '단기예보',
    __popSource: popFromShort ? '단기예보' : (ultra?.POP != null ? '초단기예보' : (short?.POP != null ? '단기예보' : null))
  };
  return { date, values: classify(values) };
}

function buildForecastResult(grid, now, requests) {
  const [ultra, short, actual] = requests.map(x => x.status === 'fulfilled' ? x.value : null);
  if (!ultra && !short) throw new Error('초단기·단기 예보를 모두 가져오지 못했습니다. 발급된 API 키의 승인 여부를 확인하세요.');
  const near = grouped(ultra?.items), far = grouped(short?.items);
  const start = forecastWindowStart(now);
  const hourly = [];
  for (let i = 0; i < 12; i++) {
    const hour = forecastHour(near, far, start, i);
    if (hour) hourly.push({ time: isoKst(hour.date), offset: i + 1, ...hour.values });
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
    updatedAt: new Date(now).toISOString(),
    sources: { ultra: ultra?.base || null, short: short?.base || null, observed: actual?.base || null },
    notices: requests.filter(x => x.status === 'rejected').map(x => errMessage(x.reason)).slice(0, 3),
    windowStart: isoKst(start),
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
 * - 유효 위험수준: 0(안전) / 1(관심) / 2(주의) / 3(위험)
 * - null·미수신·결측은 절대 0(안전)으로 치환하지 않고 '정보 없음'으로 분리 (No False Safety)
 */
const ROAD_ICE_LABELS = ['안전', '관심', '주의', '위험'];
const ROAD_FOG_LABELS = ['안개없음', '관심', '주의', '위험'];

function normalizeRiskGrade(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw <= 3 ? raw : null;
  }
  const str = String(raw).trim();
  if (!/^[0-3]$/.test(str)) return null;
  return Number(str);
}

function formatRoadIceLabel(grade) {
  const g = normalizeRiskGrade(grade);
  return g === null ? '정보 없음' : ROAD_ICE_LABELS[g];
}

function formatRoadFogLabel(grade) {
  const g = normalizeRiskGrade(grade);
  return g === null ? '정보 없음' : ROAD_FOG_LABELS[g];
}

function parseZipEntryTimestamp(entryName) {
  const m = String(entryName || '').match(/_(\d{12})\.csv$/i);
  if (!m) return null;
  const raw = m[1];
  const yr = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(4, 6)) - 1;
  const da = Number(raw.slice(6, 8));
  const hr = Number(raw.slice(8, 10));
  const mi = Number(raw.slice(10, 12));
  // road_file_down.php 내부 파일명 시각은 UTC 12자리(YYYYMMDDHHmm)
  const utcMs = Date.UTC(yr, mo, da, hr, mi, 0);
  if (!Number.isFinite(utcMs)) return null;
  return {
    tmUtc: raw,
    tmKst: isoKst(kst(utcMs))
  };
}

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
    let fLon, fLat, tLon, tLat, rawLv, flag;
    if (is1Km) {
      if (p.length < 8) continue;
      fLon = Number(p[2]); fLat = Number(p[3]); tLon = Number(p[4]); tLat = Number(p[5]);
      rawLv = p[6]; flag = Number(p[7]);
    } else {
      if (p.length < 8) continue;
      fLon = Number(p[3]); fLat = Number(p[4]); tLon = Number(p[5]); tLat = Number(p[6]);
      rawLv = p[7]; flag = 0;
    }
    if (!Number.isFinite(fLat) || !Number.isFinite(fLon)) continue;
    const lat = Number.isFinite(tLat) ? (fLat + tLat) / 2 : fLat;
    const lon = Number.isFinite(tLon) ? (fLon + tLon) / 2 : fLon;
    // 0~3 유효 등급만 인정하고 결측(-999 등)은 null로 보존하여 결측을 0(안전)으로 오인하지 않음
    const level = normalizeRiskGrade(rawLv);
    rows.push({ lat, lon, level, flag: flag === 1 ? 1 : 0 });
  }
  return rows;
}

function summarizeSegmentWindow(lat, lon, frgRows, fogRows, radiusKm = 2.5) {
  let maxIce = null, maxFog = null, sensorObserved = false;
  const iceCounts = [0, 0, 0, 0];
  const fogCounts = [0, 0, 0, 0];
  let nearestDist = Infinity, nearestIce = null, nearestFog = null;
  let segCount = 0, validIceCount = 0, missingIceCount = 0;
  let fogSegCount = 0, validFogCount = 0, missingFogCount = 0;

  // Rough bounding box (~1 deg lat ≈ 111km, lon ≈ 90km) before Haversine keeps loop < 1ms
  const latDeg = radiusKm / 100;
  const lonDeg = radiusKm / 80;

  for (let i = 0; i < frgRows.length; i++) {
    const r = frgRows[i];
    if (Math.abs(r.lat - lat) > latDeg || Math.abs(r.lon - lon) > lonDeg) continue;
    const d = distanceKm(lat, lon, r.lat, r.lon);
    if (d <= radiusKm) {
      segCount++;
      if (r.flag === 1) sensorObserved = true;
      if (r.level === null) {
        missingIceCount++;
      } else {
        validIceCount++;
        iceCounts[r.level] = (iceCounts[r.level] || 0) + 1;
        if (maxIce === null || r.level > maxIce) maxIce = r.level;
        if (d < nearestDist) { nearestDist = d; nearestIce = r.level; }
      }
    }
  }
  let nearestFogDist = Infinity;
  for (let i = 0; i < fogRows.length; i++) {
    const r = fogRows[i];
    if (Math.abs(r.lat - lat) > latDeg || Math.abs(r.lon - lon) > lonDeg) continue;
    const d = distanceKm(lat, lon, r.lat, r.lon);
    if (d <= radiusKm) {
      fogSegCount++;
      if (r.level === null) {
        missingFogCount++;
      } else {
        validFogCount++;
        fogCounts[r.level] = (fogCounts[r.level] || 0) + 1;
        if (maxFog === null || r.level > maxFog) maxFog = r.level;
        if (d < nearestFogDist) { nearestFogDist = d; nearestFog = r.level; }
      }
    }
  }

  const dataStatus = validIceCount > 0 ? (missingIceCount > 0 ? 'partial' : 'ok') : 'missing';

  return {
    segmentCount: segCount,
    validIceCount,
    missingIceCount,
    fogSegmentCount: fogSegCount,
    validFogCount,
    missingFogCount,
    dataStatus,
    nearestDistKm: Number.isFinite(nearestDist) ? Number(nearestDist.toFixed(2)) : null,
    nearestIce,
    nearestFog,
    iceLevel: maxIce,
    iceLabel: formatRoadIceLabel(maxIce),
    fogLevel: maxFog,
    fogLabel: formatRoadFogLabel(maxFog),
    iceCounts,
    fogCounts,
    flagLabel: sensorObserved ? '관측' : '분석'
  };
}

function combineRiskLevels(a, b) {
  const ga = normalizeRiskGrade(a);
  const gb = normalizeRiskGrade(b);
  if (ga === null && gb === null) return null;
  if (ga === null) return gb;
  if (gb === null) return ga;
  return Math.max(ga, gb);
}

function matchStationRiskForCoord(lat, lon, stationRisks, frgRows, fogRows, radiusKm = 6) {
  let bestStn = null, bestDist = Infinity;
  for (const s of stationRisks || []) {
    const d = distanceKm(lat, lon, s.lat, s.lon);
    if (d < bestDist) { bestDist = d; bestStn = s; }
  }
  const localWin = frgRows?.length
    ? summarizeSegmentWindow(lat, lon, frgRows, fogRows, radiusKm)
    : {
        segmentCount: 0,
        validIceCount: 0,
        missingIceCount: 0,
        validFogCount: 0,
        missingFogCount: 0,
        dataStatus: 'missing',
        iceLevel: null,
        fogLevel: null,
        iceCounts: [0, 0, 0, 0],
        fogCounts: [0, 0, 0, 0],
        flagLabel: '분석'
      };

  const iceLevel = combineRiskLevels(localWin.iceLevel, bestStn?.iceLevel);
  const fogLevel = combineRiskLevels(localWin.fogLevel, bestStn?.fogLevel);
  const stnIceLv = normalizeRiskGrade(bestStn?.iceLevel);
  const stnFogLv = normalizeRiskGrade(bestStn?.fogLevel);
  return {
    stationId: bestStn?.stnId || null,
    stationName: bestStn?.name || null,
    stationKm: bestStn?.km ?? null,
    stationType: bestStn?.stationType || null,
    stationDistanceKm: Number.isFinite(bestDist) ? Number(bestDist.toFixed(2)) : null,
    stationIceLevel: stnIceLv,
    stationIceLabel: formatRoadIceLabel(stnIceLv),
    stationFogLevel: stnFogLv,
    stationFogLabel: formatRoadFogLabel(stnFogLv),
    iceLevel,
    iceLabel: formatRoadIceLabel(iceLevel),
    fogLevel,
    fogLabel: formatRoadFogLabel(fogLevel),
    dataStatus: iceLevel === null ? 'missing' : (localWin.dataStatus === 'partial' ? 'partial' : 'ok'),
    segmentCount: localWin.segmentCount || bestStn?.segmentCount || 0,
    iceCounts: localWin.iceCounts,
    fogCounts: localWin.fogCounts,
    flagLabel: localWin.flagLabel === '관측' || bestStn?.flagLabel === '관측' ? '관측' : '분석'
  };
}

function summarizeRoadRiskScope(frgSubset, fogSubset, meta = {}) {
  const iceCounts = [0, 0, 0, 0];
  const fogCounts = [0, 0, 0, 0];
  let maxIce = null, maxFog = null;
  let validIceCount = 0, missingIceCount = 0, sensorFlagCount = 0;
  let validFogCount = 0, missingFogCount = 0;

  for (const r of frgSubset) {
    if (r.flag === 1) sensorFlagCount++;
    if (r.level === null) {
      missingIceCount++;
    } else {
      validIceCount++;
      iceCounts[r.level] = (iceCounts[r.level] || 0) + 1;
      if (maxIce === null || r.level > maxIce) maxIce = r.level;
    }
  }
  for (const r of fogSubset) {
    if (r.level === null) {
      missingFogCount++;
    } else {
      validFogCount++;
      fogCounts[r.level] = (fogCounts[r.level] || 0) + 1;
      if (maxFog === null || r.level > maxFog) maxFog = r.level;
    }
  }

  return {
    ...meta,
    unit: '1km-segment',
    total1km: frgSubset.length,
    validIceCount,
    missingIceCount,
    sensorFlagCount,
    observedCount: sensorFlagCount, // 하위 호환 별칭 유지 (CSV FLAG=1 센서실측 세그먼트 수)
    maxIce,
    iceLabel: formatRoadIceLabel(maxIce),
    iceCounts,
    totalFog1km: fogSubset.length,
    validFogCount,
    missingFogCount,
    maxFog,
    fogLabel: formatRoadFogLabel(maxFog),
    fogCounts,
    dataStatus: validIceCount > 0 ? (missingIceCount > 0 ? 'partial' : 'ok') : 'missing'
  };
}

function buildRoadRiskPayload({
  roadNum = '012',
  tmUtc,
  tmKst,
  frgTmUtc = null,
  frgTmKst = null,
  fogTmUtc = null,
  fogTmKst = null,
  frgRows = [],
  fogRows = []
}) {
  // 1) 선행 감시 코리도: 남원주차장 인근(50.0k, 127.33E) ~ 옥포JC(176.0k, 128.48E) — 무안~순창(0~50k) 과집계 배제
  const inCorridor = r => r.lon >= 127.33 && r.lon <= 128.48 && r.lat >= 35.38 && r.lat <= 35.81;
  // 2) 고령지사 공식 관할 구간: 함양IC(95.0km, 127.745E) ~ 옥포JC(176.0km, 128.468E)
  const inBranch = r => r.lon >= 127.745 && r.lon <= 128.468 && r.lat >= 35.51 && r.lat <= 35.80;

  const allRouteSummary = summarizeRoadRiskScope(frgRows, fogRows, {
    scope: 'all-route',
    rangeLabel: '무안IC~옥포JC(012선 전구간)'
  });
  const corridorSummary = summarizeRoadRiskScope(
    frgRows.filter(inCorridor),
    fogRows.filter(inCorridor),
    {
      scope: 'corridor-50-176k',
      startKm: 50.0,
      endKm: 176.0,
      rangeLabel: '남원(50.0k)~옥포JC(176.0k)'
    }
  );
  const branchSummary = summarizeRoadRiskScope(
    frgRows.filter(inBranch),
    fogRows.filter(inBranch),
    {
      scope: 'goryeong-branch-95-176k',
      startKm: 95.0,
      endKm: 176.0,
      rangeLabel: '함양IC(95.0k)~옥포JC(176.0k)'
    }
  );

  const stationRisks = CORRIDOR_ANCHOR_STATIONS.map(stn => {
    const win = summarizeSegmentWindow(stn.lat, stn.lon, frgRows, fogRows, 2.5);
    return {
      stnId: stn.stnId,
      name: stn.name,
      stationType: stn.stationType,
      km: stn.km,
      inBranch: stn.km >= 95.0 && stn.km <= 176.0,
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
    tmUtc: frgTmUtc || tmUtc,
    tmKst: frgTmKst || tmKst,
    sources: {
      frgTmUtc: frgTmUtc || tmUtc || null,
      frgTmKst: frgTmKst || tmKst || null,
      fogTmUtc: fogTmUtc || tmUtc || null,
      fogTmKst: fogTmKst || tmKst || null
    },
    updatedAt: new Date().toISOString(),
    allRouteSummary,
    corridorSummary,
    branchSummary,
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
  const todayDayNum = kst(now).getUTCDate();
  const startK = forceStartK ?? forecastWindowStart(now);

  // 시작 시각 ~ 내일 23:00 KST 범위 (최소 24시간, 최대 48시간)
  const targetHours = Math.max(24, Math.min(48, (24 - startK.getUTCHours()) + 24));
  const hours = [];

  for (let i = 0; i < targetHours; i++) {
    const hour = forecastHour(near, far, startK, i);
    if (!hour) continue;
    const { date: d, values: c } = hour;
    const hKst = d.getUTCHours();
    const dNum = d.getUTCDate();
    hours.push({
      offset: i,
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
      source: c.source,
      popSource: c.popSource
    });
  }

  return {
    id: region.id,
    windowStart: isoKst(startK),
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
      ultra: ultraRes?.base || null,
      shortFallback: Boolean(shortRes?.notice || shortRes?.stale),
      ultraFallback: Boolean(ultraRes?.notice || ultraRes?.stale),
      fallbackReason: shortRes?.notice || ultraRes?.notice || null
    },
    hours,
    summaries: {
      h6: summarizeHourlyWindow(hours.filter(h => h.offset < 6)),
      h12: summarizeHourlyWindow(hours.filter(h => h.offset < 12)),
      h24: summarizeHourlyWindow(hours.filter(h => h.offset < 24)),
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

  const shortBases = [...new Set(regions.map(r => r.sources?.short).filter(Boolean))].sort();
  const ultraBases = [...new Set(regions.map(r => r.sources?.ultra).filter(Boolean))].sort();
  // 보수적 기준시각: 격자 간 회차가 섞여 있으면 가장 오래된 회차를 shortBase로 표기해 구회차를 최신회차로 둔갑시키지 않음 (No Silent Stale)
  const oldestShort = shortBases[0] || null;
  const latestShort = shortBases.at(-1) || null;
  const oldestUltra = ultraBases[0] || null;
  const latestUltra = ultraBases.at(-1) || null;
  const mixedGeneration = shortBases.length > 1 || ultraBases.length > 1;
  const isFallback = regions.some(r => r.sources?.shortFallback || r.sources?.ultraFallback);
  const shortTag = oldestShort ? oldestShort.replace(/\D/g, '').slice(0, 12) : 'none';
  const ultraTag = oldestUltra ? oldestUltra.replace(/\D/g, '').slice(0, 12) : 'none';

  return {
    ok: true,
    mode: 'short-term-12',
    snapshotId: `kma-short13-${shortTag}-${ultraTag}${mixedGeneration ? '-mixed' : ''}`,
    updatedAt: new Date(now).toISOString(),
    uniqueGridCount: gridGroups.size,
    sources: {
      shortBase: oldestShort,
      latestShortBase: latestShort,
      ultraBase: oldestUltra,
      latestUltraBase: latestUltra,
      shortBases,
      ultraBases,
      mixedGeneration,
      isFallback,
      status: mixedGeneration ? 'mixed' : (isFallback ? 'fallback' : 'fresh')
    },
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
  // Cloudflare Workers 동시 아웃바운드 6연결 한도 내 여유 확보(도로관측·특보 병행 시 타임아웃 방지): 격자 2개(=최대 4요청)씩 분할
  const chunkSize = 2;
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
  for (let idx = 0; idx < retryEntries.length; idx += 2) {
    const batch = retryEntries.slice(idx, idx + 2);
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

  const uniformStartK = forecastWindowStart(now);
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
 * 과거 N시간(기본 6시간) 도로기상관측 이력 조회용 KST 슬롯 목록을 생성한다.
 * - 과거 구간은 stepMin(기본 30분) 정각 경계에 정렬해 불변 캐시 적중률을 극대화
 * - 마지막 슬롯은 KMA 3분 발표 지연을 반영한 최신 관측 시각(now - 3분)
 */
function buildRoadTrendSlots(nowMs = Date.now(), { hours = 6, stepMin = 30 } = {}) {
  const safeHours = Math.max(1, Math.min(12, Math.round(Number(hours) || 6)));
  const allowedSteps = [15, 30, 60];
  const safeStep = allowedSteps.includes(Number(stepMin)) ? Number(stepMin) : 30;
  const stepMs = safeStep * 60000;
  const latestMs = Math.floor((nowMs - 3 * 60000) / 60000) * 60000;
  const windowStartMs = nowMs - safeHours * 3600000;
  const firstAlignedMs = Math.ceil(windowStartMs / stepMs) * stepMs;

  const slotMsList = [];
  for (let ms = firstAlignedMs; ms <= latestMs - 6 * 60000; ms += stepMs) {
    slotMsList.push(ms);
  }
  slotMsList.push(latestMs);

  return slotMsList.map((ms, idx) => {
    const d = kst(ms);
    return {
      ms,
      tm1: datePart(d) + timePart(d),
      iso: isoKst(d),
      isLatest: idx === slotMsList.length - 1,
      immutable: (nowMs - ms) >= 10 * 60000
    };
  });
}

/**
 * 슬롯별 parseRoadStations() 결과를 관측소별 초경량 시계열(~2.5KB)로 조립한다.
 */
function assembleRoadTrendPayload({ line = '14', hours = 6, stepMin = 30, slotResults = [], nowMs = Date.now() } = {}) {
  const validSlots = [...(slotResults || [])]
    .filter(r => r && r.slot && Array.isArray(r.stations) && r.stations.some(s => Number.isFinite(s?.roadTemp) || Number.isFinite(s?.temp)))
    .sort((a, b) => a.slot.ms - b.slot.ms);

  const times = validSlots.map(r => r.slot.iso);
  const stnMeta = new Map();
  for (const r of validSlots) {
    for (const s of r.stations) {
      if (!s?.stnId) continue;
      const id = String(s.stnId);
      if (!stnMeta.has(id)) {
        stnMeta.set(id, {
          name: s.name || id,
          km: Number.isFinite(s.milepostKm) ? Number(s.milepostKm.toFixed(1)) : null
        });
      }
    }
  }

  const stations = {};
  for (const [id, meta] of stnMeta.entries()) {
    const tr = [];
    const ta = [];
    for (const r of validSlots) {
      const found = r.stations.find(s => String(s?.stnId) === id);
      tr.push(found && Number.isFinite(found.roadTemp) ? Number(found.roadTemp.toFixed(1)) : null);
      ta.push(found && Number.isFinite(found.temp) ? Number(found.temp.toFixed(1)) : null);
    }
    if (tr.some(v => v !== null) || ta.some(v => v !== null)) {
      stations[id] = { name: meta.name, km: meta.km, tr, ta };
    }
  }

  return {
    ok: true,
    line: String(line || '14'),
    hours: Math.max(1, Math.min(12, Math.round(Number(hours) || 6))),
    stepMin: Number(stepMin) || 30,
    updatedAt: new Date(nowMs).toISOString(),
    times,
    stations
  };
}

/**
 * 일 2회(08:00 아침판 / 18:00 저녁판 KST) 브리핑 회차 메타데이터 산출 (lib/share-status.js 규격 정렬)
 */
function resolveBriefingEditionMeta(nowMs = Date.now()) {
  const KST_OFF = 9 * 3600000;
  const local = new Date(nowMs + KST_OFF);
  const hour = local.getUTCHours();
  const morning = hour >= 8 && hour < 18;
  const slot = morning ? 'morning' : 'night';
  if (hour < 8) local.setUTCDate(local.getUTCDate() - 1);
  local.setUTCHours(morning ? 8 : 18, 0, 0, 0);
  const startMs = local.getTime() - KST_OFF;
  const nextMs = startMs + (morning ? 10 : 14) * 3600000;
  const fmtIso = ms => new Date(ms + KST_OFF).toISOString().slice(0, 19) + '+09:00';
  return {
    editionId: `${local.toISOString().slice(0, 10)}-${slot}`,
    slot,
    collectFrom: fmtIso(startMs),
    collectUntil: fmtIso(startMs + 3600000),
    nextEditionAt: fmtIso(nextMs)
  };
}

/**
 * 제설 사후분석용 단일 시점·관측소 예비살포/결빙 조건 자동 분류
 */
function classifyPresaltConditionRow({ temp = null, roadTemp = null, surfaceCode = null, dayPrecip = null } = {}) {
  const tr = Number.isFinite(roadTemp) ? roadTemp : null;
  const ta = Number.isFinite(temp) ? temp : null;
  const sc = Number.isFinite(surfaceCode) ? surfaceCode : Number(surfaceCode || 0);
  const rn = Number.isFinite(dayPrecip) ? dayPrecip : 0;

  if (sc === 5) return { flag: 'ice', label: '실측결빙' };
  if (sc === 6) return { flag: 'snow', label: '적설·슬러시' };
  if (sc === 4 && tr !== null && tr <= 2.0) return { flag: 'frost', label: '서리(노면≤2℃)' };
  if (tr !== null && tr <= 2.0 && (ta === null || ta <= 4.0) && ((sc >= 2 && sc <= 6) || rn > 0)) {
    return { flag: 'presalt', label: '예비살포조건(저온습윤)' };
  }
  if (tr !== null && tr <= 0.0) return { flag: 'subzero', label: '노면영하(건조)' };
  if (tr !== null && tr <= 2.0) return { flag: 'cold', label: '노면저온(≤2℃)' };
  return { flag: 'normal', label: '정상' };
}

/**
 * STEP 5 (72시간 제설근무 매칭·CSV 추출용) 청크 단위 KST 슬롯 생성기
 * - Cloudflare Workers 단일 요청 50 subrequest 한도 준수를 위해 1회 최대 37슬롯으로 안전 제한
 */
function buildRoadHistoryWindowSlots({ endMs = Date.now(), hours = 12, stepMin = 30, nowMs = Date.now() } = {}) {
  const allowedSteps = [10, 15, 30, 60];
  const safeStep = allowedSteps.includes(Number(stepMin)) ? Number(stepMin) : 30;
  const maxHoursForStep = Math.min(24, Math.floor((36 * safeStep) / 60));
  const safeHours = Math.max(1, Math.min(maxHoursForStep, Math.round(Number(hours) || 12)));
  const stepMs = safeStep * 60000;

  const latestAllowedMs = Math.floor((nowMs - 2 * 60000) / 60000) * 60000;
  const clampedEndMs = Math.min(Number.isFinite(Number(endMs)) ? Number(endMs) : latestAllowedMs, latestAllowedMs);
  const alignedEndMs = Math.floor(clampedEndMs / stepMs) * stepMs;
  const startMs = alignedEndMs - safeHours * 3600000;
  const firstAlignedMs = Math.ceil(startMs / stepMs) * stepMs;

  const slotMsList = [];
  for (let ms = firstAlignedMs; ms <= alignedEndMs && slotMsList.length < 37; ms += stepMs) {
    slotMsList.push(ms);
  }
  if (!slotMsList.length) slotMsList.push(alignedEndMs);

  return slotMsList.map((ms, idx) => {
    const d = kst(ms);
    return {
      ms,
      tm1: datePart(d) + timePart(d),
      iso: isoKst(d),
      isLatest: idx === slotMsList.length - 1,
      immutable: (nowMs - ms) >= 10 * 60000
    };
  });
}

/**
 * STEP 5 슬롯별 도로기상관측 결과를 전체 기상요소(기온·노면·습도·노면상태·강수·적설·풍속·가시거리·예비살포판정)로 조립
 */
function assembleRoadHistoryChunk({ line = '14', hours = 12, stepMin = 30, slotResults = [], nowMs = Date.now() } = {}) {
  const validSlots = [...(slotResults || [])]
    .filter(r => r && r.slot && Array.isArray(r.stations) && r.stations.length > 0)
    .sort((a, b) => a.slot.ms - b.slot.ms);

  const times = validSlots.map(r => r.slot.iso);
  const tm1s = validSlots.map(r => r.slot.tm1);
  const stnMeta = new Map();
  for (const r of validSlots) {
    for (const s of r.stations) {
      if (!s?.stnId) continue;
      const id = String(s.stnId);
      if (!stnMeta.has(id)) {
        stnMeta.set(id, {
          stnId: id,
          name: s.name || id,
          km: Number.isFinite(s.milepostKm) ? Number(s.milepostKm.toFixed(1)) : null,
          stationType: s.stationType || '',
          elevation: Number.isFinite(s.elevation) ? s.elevation : null
        });
      }
    }
  }

  const stations = {};
  for (const [id, meta] of stnMeta.entries()) {
    const tr = [], ta = [], rh = [], sc = [], ss = [], rn = [], sd = [], ws = [], vis = [], presalt = [];
    let anyValid = false;
    for (const r of validSlots) {
      const f = r.stations.find(s => String(s?.stnId) === id);
      if (!f) {
        tr.push(null); ta.push(null); rh.push(null); sc.push(null); ss.push(null);
        rn.push(null); sd.push(null); ws.push(null); vis.push(null); presalt.push(null);
        continue;
      }
      const trVal = Number.isFinite(f.roadTemp) ? Number(f.roadTemp.toFixed(1)) : null;
      const taVal = Number.isFinite(f.temp) ? Number(f.temp.toFixed(1)) : null;
      if (trVal !== null || taVal !== null) anyValid = true;
      tr.push(trVal);
      ta.push(taVal);
      rh.push(Number.isFinite(f.humidity) ? Math.round(f.humidity) : null);
      sc.push(Number.isFinite(f.surfaceCode) ? f.surfaceCode : null);
      ss.push(f.surfaceState || null);
      rn.push(Number.isFinite(f.dayPrecip) ? Number(f.dayPrecip.toFixed(1)) : null);
      sd.push(Number.isFinite(f.snowDepth) ? Number(f.snowDepth.toFixed(1)) : null);
      ws.push(Number.isFinite(f.windSpeed) ? Number(f.windSpeed.toFixed(1)) : null);
      vis.push(Number.isFinite(f.visibility) ? Math.round(f.visibility) : null);
      presalt.push(classifyPresaltConditionRow(f).label);
    }
    if (anyValid) {
      stations[id] = { ...meta, tr, ta, rh, sc, ss, rn, sd, ws, vis, presalt };
    }
  }

  return {
    ok: true,
    line: String(line || '14'),
    hours: Number(hours) || 12,
    stepMin: Number(stepMin) || 30,
    slotCount: times.length,
    updatedAt: new Date(nowMs).toISOString(),
    times,
    tm1s,
    stations
  };
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


// ─── 광주대구선 RWIS·CCTV (/rwis) ───
const { handleRwisFetch } = (() => {
/**
 * 광주대구선(무안광주대구선 12호선) CCTV + 도로기상(RWIS) 통합 Worker
 * ─ Cloudflare Workers · ES Module 형식 · v2.0
 *
 *   GET /api/status            CCTV(123대) + RWIS(16개 구간)를 한 번에 (권장)
 *   GET /api/cctv              ITS Open API CCTV 목록 + 123대 마스터 매칭 (15분 캐시)
 *   GET /api/rwis              기상청 RWIS 도로살얼음(FSM)·가시거리(VIR) 등급 (5분 캐시)
 *   GET /api/stream?cctvId=…   로드플러스 CCTV 실시간 HLS 주소 + 스냅샷 (2분 캐시)
 *   ?refresh=1                 해당 엔드포인트의 캐시를 무시하고 즉시 갱신
 *   OPTIONS …                  CORS preflight
 *   GET /                      사용 안내(JSON)
 *
 * 환경변수(모두 선택)
 *   ITS_API_KEY       ITS 국가교통정보센터 Open API 키 (wrangler secret put ITS_API_KEY)
 *   CCTV_SOURCE_URL   ITS 대신 같은 형식 JSON을 받아올 주소 (9443 포트가 막힐 때)
 *   RWIS_SOURCE_URL   RWIS 대신 tools/rwis_export.py가 만든 사전 계산 JSON 주소
 *                     (무료 플랜 CPU 한도 때문에 권장 — README 4장)
 *   RWIS_BASE         RWIS 호스트 교체용 (기본 https://rwis.kma.go.kr)
 *
 * 영상 트래픽은 Worker를 지나가지 않습니다. Worker는 목록·주소(JSON)만 중계하고
 * .m3u8/영상 조각은 브라우저의 hls.js가 *.hscdn.com에서 직접 받습니다.
 */

const VERSION = '2.3.0';

const CACHE_TTL = {
  cctv: 900,      // 15분 — ITS 원본 갱신 주기
  rwis: 120,      // 2분  — RWIS 5분 슬롯 신속 반영 (스트리밍 파서 경량화 적용)
  stream: 120,    // 2분  — 로드플러스 HLS 주소
  conzone: 21600, // 6시간 — 구간·링크 구성(거의 안 바뀜)
};

const UPSTREAM_TIMEOUT_MS = 15000;
const ITS_ENDPOINT = 'https://openapi.its.go.kr:9443/cctvInfo';
const ROADPLUS_ENDPOINT = 'https://www.roadplus.co.kr/api/main/selectCctvInfoAjax';
const ROADPLUS_TIMEOUT_MS = 10000;

// 남원 127.39°E ~ 대구 논공 128.45°E, 35.38°N ~ 35.80°N 전체 커버
const BOUNDS = { minX: 127.25, maxX: 128.65, minY: 35.3, maxY: 35.9 };

// 무안광주대구선 노선 코드 (getConZoneByRoadNo.do 파라미터)
const ROAD = { roadNo: '012', roadNoN1: '12', roadNoN2: '0120', name: '무안광주대구선' };

/**
 * RWIS 방향 코드
 *   E = cdpntTmnlDirDvCd '종점' 방향 = 무안 → 대구 (대구방향)
 *   S = '기점' 방향 = 대구 → 무안 (광주방향)
 */
const RWIS_DIRS = [
  { code: 'E', label: '대구방향', short: '대구' },
  { code: 'S', label: '광주방향', short: '광주' },
];

/** 위험등급 이름(기상청 RWIS 공식): 0 안전 · 1 관심 · 2 주의 · 3 위험 */
const LEVEL_NAME = ['안전', '관심', '주의', '위험'];
const LEVEL_DETAIL = ['0단계 · 안전', '1단계 · 관심', '2단계 · 주의', '3단계 · 위험'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/* @MASTER_START */
const MASTER = {"route":"광주대구선","routeNo":"012","range":{"startKm":95.0,"endKm":176.0,"startName":"함양IC","endName":"옥포JC"},"zones":[{"suffix":"160","startKm":95.0,"endKm":97.3,"name":"함양IC–함양JC","nearIds":[],"nearNames":[]},{"suffix":"170","startKm":97.3,"endKm":121.1,"name":"함양JC–거창IC","nearIds":[],"nearNames":[]},{"suffix":"180","startKm":121.1,"endKm":131.1,"name":"거창IC–가조IC","nearIds":[],"nearNames":[]},{"suffix":"190","startKm":131.1,"endKm":146.4,"name":"가조IC–해인사IC","nearIds":[],"nearNames":[]},{"suffix":"200","startKm":146.4,"endKm":152.9,"name":"해인사IC–고령IC","nearIds":[],"nearNames":[]},{"suffix":"210","startKm":152.9,"endKm":165.52,"name":"고령IC–동고령IC","nearIds":[],"nearNames":[]},{"suffix":"220","startKm":165.52,"endKm":166.99,"name":"동고령IC–고령JC","nearIds":["p50","p51","p52"],"nearNames":["기산2교","기족교","고령분기점_광주대구"]},{"suffix":"230","startKm":166.99,"endKm":176.0,"name":"고령JC–옥포JC","nearIds":[],"nearNames":[]}],"points":[{"name":"두산","km":95.0,"kmSource":"산출","facility":"일반(마을)","address":"경남 함양군 함양읍 신관리 산 87-6","lat":35.533423,"lon":127.748989,"cctvId":"cctv00001457","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km) / 함양IC 인접(경계)","cams":[{"dir":"G","seq":3,"cctvId":"cctv00001457"}],"id":"p01","zone":"160"},{"name":"함양","km":95.0,"kmSource":"공식","facility":"IC","address":"경남 함양군 함양읍 신관리 산 87-6","lat":35.533199,"lon":127.748835,"cctvId":"cctv00005751","note":"","cams":[{"dir":"D","seq":1,"cctvId":"cctv00005751"},{"dir":"G","seq":2,"cctvId":"cctv00005751"}],"id":"p02","zone":"160"},{"name":"지곡","km":96.23,"kmSource":"산출","facility":"IC","address":"경남 함양군 함양읍 백천리 산 56-1","lat":35.532314,"lon":127.760938,"cctvId":"cctv00005752","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":4,"cctvId":"cctv00005752"},{"dir":"G","seq":5,"cctvId":"cctv00005752"}],"id":"p03","zone":"160"},{"name":"원평교","km":98.19,"kmSource":"공식","facility":"교량","address":"경남 함양군 지곡면 도촌리 241-1","lat":35.538839,"lon":127.777535,"cctvId":"cctv00005754","note":"","cams":[{"dir":"D","seq":6,"cctvId":"cctv00005754"},{"dir":"G","seq":7,"cctvId":"cctv00005754"}],"id":"p04","zone":"170"},{"name":"우명교","km":99.93,"kmSource":"산출","facility":"교량","address":"경남 함양군 수동면 우명리 산 97-1","lat":35.548953,"lon":127.794978,"cctvId":"cctv00005755","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":8,"cctvId":"cctv00005755"},{"dir":"G","seq":9,"cctvId":"cctv00005755"}],"id":"p05","zone":"170"},{"name":"함양산삼골휴게소","km":100.8,"kmSource":"공식","facility":"휴게소","address":"경남 함양군 수동면 하교리 산 12-2","lat":35.550969,"lon":127.808505,"cctvId":"cctv00005756","note":"","cams":[{"dir":"D","seq":10,"cctvId":"cctv00005756"},{"dir":"G","seq":11,"cctvId":"cctv00005756"}],"id":"p06","zone":"170"},{"name":"죽산천교1","km":102.68,"kmSource":"공식","facility":"교량","address":"경남 함양군 수동면 죽산리 1282-15","lat":35.548226,"lon":127.827499,"cctvId":"cctv00005757","note":"","cams":[{"dir":"D","seq":12,"cctvId":"cctv00005757"},{"dir":"G","seq":13,"cctvId":"cctv00005757"}],"id":"p07","zone":"170"},{"name":"죽산교","km":104.75,"kmSource":"공식","facility":"교량","address":"경남 함양군 수동면 죽산리 403","lat":35.554471,"lon":127.834004,"cctvId":"cctv00005758","note":"","cams":[{"dir":"D","seq":14,"cctvId":"cctv00005758"},{"dir":"G","seq":15,"cctvId":"cctv00005758"}],"id":"p08","zone":"170"},{"name":"춘전리","km":107.45,"kmSource":"산출","facility":"일반(마을)","address":"경남 거창군 남상면 춘전리 381-1","lat":35.57966,"lon":127.852194,"cctvId":"cctv00005759","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":16,"cctvId":"cctv00005759"},{"dir":"G","seq":17,"cctvId":"cctv00005759"}],"id":"p09","zone":"170"},{"name":"춘전1육교","km":107.85,"kmSource":"산출","facility":"교량","address":"경남 거창군 남상면 춘전리 293-3","lat":35.582185,"lon":127.854997,"cctvId":"cctv00005760","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":18,"cctvId":"cctv00005760"},{"dir":"G","seq":19,"cctvId":"cctv00005760"}],"id":"p10","zone":"170"},{"name":"춘전재 토석류","km":108.2,"kmSource":"산출","facility":"일반(마을)","address":"경남 거창군 남상면 춘전리 산 89-3","lat":35.586785,"lon":127.859683,"cctvId":"cctv00000110","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":20,"cctvId":"cctv00000110"},{"dir":"G","seq":21,"cctvId":"cctv00000110"}],"id":"p11","zone":"170"},{"name":"남상","km":109.58,"kmSource":"산출","facility":"일반(마을)","address":"경남 거창군 남상면 둔동리 산 50-1","lat":35.593586,"lon":127.873424,"cctvId":"cctv00001458","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":22,"cctvId":"cctv00001458"},{"dir":"G","seq":23,"cctvId":"cctv00001458"}],"id":"p12","zone":"170"},{"name":"둔동리","km":111.37,"kmSource":"산출","facility":"일반(마을)","address":"경남 거창군 남상면 둔동리 산 120-1","lat":35.605886,"lon":127.881771,"cctvId":"cctv00005762","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":24,"cctvId":"cctv00005762"},{"dir":"G","seq":25,"cctvId":"cctv00005762"}],"id":"p13","zone":"170"},{"name":"오계교","km":113.38,"kmSource":"공식","facility":"교량","address":"경남 거창군 남상면 무촌리 1162","lat":35.631986,"lon":127.900542,"cctvId":"cctv00005763","note":"","cams":[{"dir":"D","seq":26,"cctvId":"cctv00005763"},{"dir":"G","seq":27,"cctvId":"cctv00005763"}],"id":"p14","zone":"170"},{"name":"무촌1교","km":114.76,"kmSource":"공식","facility":"교량","address":"경남 거창군 남상면 오계리 279","lat":35.62791,"lon":127.897323,"cctvId":"cctv00005764","note":"","cams":[{"dir":"D","seq":28,"cctvId":"cctv00005764"},{"dir":"G","seq":29,"cctvId":"cctv00005764"}],"id":"p15","zone":"170"},{"name":"무촌2교","km":116.02,"kmSource":"공식","facility":"교량","address":"경남 거창군 남상면 무촌리 1855-114","lat":35.641846,"lon":127.915623,"cctvId":"cctv00005765","note":"","cams":[{"dir":"D","seq":30,"cctvId":"cctv00005765"},{"dir":"G","seq":31,"cctvId":"cctv00005765"}],"id":"p16","zone":"170"},{"name":"송변교","km":117.1,"kmSource":"공식","facility":"교량","address":"경남 거창군 남상면 대산리 984-5","lat":35.648955,"lon":127.924449,"cctvId":"cctv00005766","note":"","cams":[{"dir":"D","seq":32,"cctvId":"cctv00005766"},{"dir":"G","seq":33,"cctvId":"cctv00005766"}],"id":"p17","zone":"170"},{"name":"대산육교","km":117.91,"kmSource":"산출","facility":"교량","address":"경남 거창군 남상면 월평리 산 45-8","lat":35.655854,"lon":127.925911,"cctvId":"cctv00005767","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":34,"cctvId":"cctv00005767"},{"dir":"G","seq":35,"cctvId":"cctv00005767"}],"id":"p18","zone":"170"},{"name":"정장교","km":119.54,"kmSource":"공식","facility":"교량","address":"경남 거창군 거창읍 정장리 266-9","lat":35.674607,"lon":127.930313,"cctvId":"cctv00005768","note":"","cams":[{"dir":"D","seq":36,"cctvId":"cctv00005768"},{"dir":"G","seq":37,"cctvId":"cctv00005768"}],"id":"p19","zone":"170"},{"name":"거창","km":121.1,"kmSource":"공식","facility":"IC","address":"경남 거창군 거창읍 대평리 120","lat":35.679166,"lon":127.93523,"cctvId":"cctv00005769","note":"","cams":[{"dir":"D","seq":38,"cctvId":"cctv00005769"},{"dir":"G","seq":39,"cctvId":"cctv00005769"}],"id":"p20","zone":"180"},{"name":"황강천교","km":121.49,"kmSource":"공식","facility":"교량","address":"경남 거창군 거창읍 대평리 1454-2","lat":35.681873,"lon":127.938929,"cctvId":"cctv00005770","note":"","cams":[{"dir":"D","seq":40,"cctvId":"cctv00005770"},{"dir":"G","seq":41,"cctvId":"cctv00005770"}],"id":"p21","zone":"180"},{"name":"둔마1교","km":124.16,"kmSource":"공식","facility":"교량","address":"경남 거창군 남하면 둔마리 산 83-13","lat":35.699756,"lon":127.94605,"cctvId":"cctv00005771","note":"","cams":[{"dir":"D","seq":42,"cctvId":"cctv00005771"},{"dir":"G","seq":43,"cctvId":"cctv00005771"}],"id":"p22","zone":"180"},{"name":"둔마2교","km":125.34,"kmSource":"공식","facility":"교량","address":"경남 거창군 남하면 둔마리 산 216-4","lat":35.706707,"lon":127.959538,"cctvId":"cctv00005772","note":"","cams":[{"dir":"D","seq":44,"cctvId":"cctv00005772"},{"dir":"G","seq":45,"cctvId":"cctv00005772"}],"id":"p23","zone":"180"},{"name":"살피재터널(외부광주)","km":126.58,"kmSource":"공식","facility":"터널","address":"경남 거창군 가조면 동례리 산 251-4","lat":35.707317,"lon":127.988983,"cctvId":"cctv00000509","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":48,"cctvId":"cctv00000509"},{"dir":"G","seq":49,"cctvId":"cctv00000509"}],"id":"p24","zone":"180"},{"name":"살피재터널(외부대구)","km":126.58,"kmSource":"공식","facility":"터널","address":"경남 거창군 남하면 둔마리 산 131-5","lat":35.70834,"lon":127.966184,"cctvId":"cctv00000508","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":46,"cctvId":"cctv00000508"},{"dir":"G","seq":47,"cctvId":"cctv00000508"}],"id":"p25","zone":"180"},{"name":"동례교","km":129.51,"kmSource":"공식","facility":"교량","address":"경남 거창군 가조면 동례리 1017-13","lat":35.702633,"lon":128.000653,"cctvId":"cctv00005773","note":"","cams":[{"dir":"D","seq":50,"cctvId":"cctv00005773"},{"dir":"G","seq":51,"cctvId":"cctv00005773"}],"id":"p26","zone":"180"},{"name":"가조","km":131.1,"kmSource":"공식","facility":"IC","address":"경남 거창군 가조면 일부리 1060-3","lat":35.701972,"lon":128.021152,"cctvId":"cctv00005774","note":"","cams":[{"dir":"D","seq":52,"cctvId":"cctv00005774"},{"dir":"G","seq":53,"cctvId":"cctv00005774"}],"id":"p27","zone":"190"},{"name":"일부육교","km":132.58,"kmSource":"산출","facility":"교량","address":"경남 거창군 가조면 일부리 259-2","lat":35.706627,"lon":128.035333,"cctvId":"cctv00005775","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":54,"cctvId":"cctv00005775"},{"dir":"G","seq":55,"cctvId":"cctv00005775"}],"id":"p28","zone":"190"},{"name":"거창휴게소","km":134.4,"kmSource":"공식","facility":"휴게소","address":"경남 거창군 가조면 도리 444-7","lat":35.70725,"lon":128.056167,"cctvId":"cctv00005776","note":"","cams":[{"dir":"D","seq":56,"cctvId":"cctv00005776"},{"dir":"G","seq":57,"cctvId":"cctv00005776"}],"id":"p29","zone":"190"},{"name":"가조터널(외부대구)","km":135.18,"kmSource":"공식","facility":"터널","address":"경남 거창군 가조면 도리 1529-102","lat":35.70675,"lon":128.06404,"cctvId":"cctv00005810","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":58,"cctvId":"cctv00005810"},{"dir":"G","seq":59,"cctvId":"cctv00005810"}],"id":"p30","zone":"190"},{"name":"가야1터널(외부광주)","km":137.24,"kmSource":"공식","facility":"터널","address":"경남 합천군 가야면 성기리 산 70-1","lat":35.708827,"lon":128.095382,"cctvId":"cctv00005812","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":62,"cctvId":"cctv00005812"},{"dir":"G","seq":63,"cctvId":"cctv00005812"}],"id":"p31","zone":"190"},{"name":"가야1터널(외부대구)","km":137.24,"kmSource":"공식","facility":"터널","address":"경남 합천군 가야면 성기리 산 105-19","lat":35.708448,"lon":128.088435,"cctvId":"cctv00005811","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":60,"cctvId":"cctv00005811"},{"dir":"G","seq":61,"cctvId":"cctv00005811"}],"id":"p32","zone":"190"},{"name":"가야2터널(외부대구)","km":139.05,"kmSource":"공식","facility":"터널","address":"경남 합천군 가야면 청현리 535","lat":35.707825,"lon":128.11897,"cctvId":"cctv00005813","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":64,"cctvId":"cctv00005813"},{"dir":"G","seq":65,"cctvId":"cctv00005813"}],"id":"p33","zone":"190"},{"name":"가야3터널(외부대구)","km":140.25,"kmSource":"공식","facility":"터널","address":"경남 합천군 야로면 묵촌리 산 34-10","lat":35.70028,"lon":128.13881,"cctvId":"cctv00005814","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":66,"cctvId":"cctv00005814"},{"dir":"G","seq":67,"cctvId":"cctv00005814"}],"id":"p34","zone":"190"},{"name":"야로2터널(외부광주)","km":143.43,"kmSource":"공식","facility":"터널","address":"경남 합천군 야로면 정대리 산 19-1","lat":35.692768,"lon":128.15625,"cctvId":"cctv00005815","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":68,"cctvId":"cctv00005815"},{"dir":"G","seq":69,"cctvId":"cctv00005815"}],"id":"p35","zone":"190"},{"name":"야로대교1","km":144.58,"kmSource":"공식","facility":"교량","address":"경남 합천군 야로면 정대리 1048-1","lat":35.692831,"lon":128.168477,"cctvId":"cctv00005777","note":"","cams":[{"dir":"D","seq":70,"cctvId":"cctv00005777"},{"dir":"G","seq":72,"cctvId":"cctv00005777"}],"id":"p36","zone":"190"},{"name":"야로대교2","km":144.58,"kmSource":"공식","facility":"교량","address":"경남 합천군 야로면 정대리 1048-1","lat":35.692831,"lon":128.168477,"cctvId":"cctv00005778","note":"","cams":[{"dir":"D","seq":71,"cctvId":"cctv00005778"},{"dir":"G","seq":73,"cctvId":"cctv00005778"}],"id":"p37","zone":"190"},{"name":"해인사","km":146.4,"kmSource":"공식","facility":"IC","address":"경남 합천군 야로면 금평리 산 47-2","lat":35.69651,"lon":128.184314,"cctvId":"cctv00005779","note":"","cams":[{"dir":"D","seq":74,"cctvId":"cctv00005779"},{"dir":"G","seq":75,"cctvId":"cctv00005779"}],"id":"p38","zone":"200"},{"name":"야로3터널(외부대구)","km":147.36,"kmSource":"공식","facility":"터널","address":"경남 합천군 야로면 청계리 산 31","lat":35.699323,"lon":128.200595,"cctvId":"cctv00000515","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":76,"cctvId":"cctv00000515"},{"dir":"G","seq":77,"cctvId":"cctv00000515"}],"id":"p39","zone":"200"},{"name":"쌍림터널(외부광주)","km":148.34,"kmSource":"공식","facility":"터널","address":"경북 고령군 쌍림면 월막리 산 42-9","lat":35.705333,"lon":128.215363,"cctvId":"cctv00000516","note":"터널 등록 이정 기준(갱구 CCTV)","cams":[{"dir":"D","seq":78,"cctvId":"cctv00000516"},{"dir":"G","seq":79,"cctvId":"cctv00000516"}],"id":"p40","zone":"200"},{"name":"월막리","km":150.21,"kmSource":"산출","facility":"일반(마을)","address":"경북 고령군 쌍림면 월막리 633-2","lat":35.704485,"lon":128.226124,"cctvId":"cctv00005780","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":80,"cctvId":"cctv00005780"},{"dir":"G","seq":81,"cctvId":"cctv00005780"}],"id":"p41","zone":"200"},{"name":"용동천1교","km":151.6,"kmSource":"공식","facility":"교량","address":"경북 고령군 쌍림면 고곡리 987-89","lat":35.700241,"lon":128.238169,"cctvId":"cctv00005781","note":"","cams":[{"dir":"D","seq":82,"cctvId":"cctv00005781"},{"dir":"G","seq":83,"cctvId":"cctv00005781"}],"id":"p42","zone":"200"},{"name":"고령","km":152.9,"kmSource":"공식","facility":"IC","address":"경북 고령군 쌍림면 고곡리 717-2","lat":35.700934,"lon":128.244782,"cctvId":"cctv00005782","note":"","cams":[{"dir":"D","seq":84,"cctvId":"cctv00005782"},{"dir":"G","seq":85,"cctvId":"cctv00005782"}],"id":"p43","zone":"210"},{"name":"안림천교","km":153.35,"kmSource":"공식","facility":"교량","address":"경북 고령군 대가야읍 외리 847-29","lat":35.707473,"lon":128.264529,"cctvId":"cctv00005783","note":"","cams":[{"dir":"D","seq":86,"cctvId":"cctv00005783"},{"dir":"G","seq":87,"cctvId":"cctv00005783"}],"id":"p44","zone":"210"},{"name":"회천대교","km":156.29,"kmSource":"산출","facility":"교량","address":"경북 고령군 대가야읍 외리 1178-68","lat":35.71189,"lon":128.285993,"cctvId":"cctv00005784","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":88,"cctvId":"cctv00005784"},{"dir":"G","seq":89,"cctvId":"cctv00005784"}],"id":"p45","zone":"210"},{"name":"양전리1","km":156.77,"kmSource":"산출","facility":"일반(마을)","address":"경북 고령군 대가야읍 장기리 산 74","lat":35.713581,"lon":128.291796,"cctvId":"cctv00005785","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":90,"cctvId":"cctv00005785"},{"dir":"G","seq":91,"cctvId":"cctv00005785"}],"id":"p46","zone":"210"},{"name":"양전리2","km":157.28,"kmSource":"산출","facility":"일반(마을)","address":"경북 고령군 개진면 양전리 419-3","lat":35.719463,"lon":128.295286,"cctvId":"cctv00005786","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":92,"cctvId":"cctv00005786"},{"dir":"G","seq":93,"cctvId":"cctv00005786"}],"id":"p47","zone":"210"},{"name":"양전교","km":158.58,"kmSource":"공식","facility":"교량","address":"경북 고령군 개진면 양전리 860-3","lat":35.724719,"lon":128.301446,"cctvId":"cctv00005787","note":"","cams":[{"dir":"D","seq":94,"cctvId":"cctv00005787"},{"dir":"G","seq":95,"cctvId":"cctv00005787"}],"id":"p48","zone":"210"},{"name":"사부1교","km":159.5,"kmSource":"공식","facility":"교량","address":"경북 고령군 성산면 사부리 413-1","lat":35.736026,"lon":128.306395,"cctvId":"cctv00005788","note":"","cams":[{"dir":"D","seq":96,"cctvId":"cctv00005788"},{"dir":"G","seq":97,"cctvId":"cctv00005788"}],"id":"p49","zone":"210"},{"name":"기산2교","km":163.0,"kmSource":"공식","facility":"교량","address":"경북 고령군 성산면 기산리 378","lat":35.745125,"lon":128.334454,"cctvId":"cctv00005790","note":"","cams":[{"dir":"D","seq":98,"cctvId":"cctv00005790"},{"dir":"G","seq":99,"cctvId":"cctv00005790"}],"id":"p50","zone":"210","nearZones":["220"]},{"name":"기족교","km":163.54,"kmSource":"공식","facility":"교량","address":"경북 고령군 성산면 기족리 976","lat":35.747618,"lon":128.346851,"cctvId":"cctv00005791","note":"","cams":[{"dir":"D","seq":100,"cctvId":"cctv00005791"},{"dir":"G","seq":101,"cctvId":"cctv00005791"}],"id":"p51","zone":"210","nearZones":["220"]},{"name":"고령분기점_광주대구","km":166.99,"kmSource":"산출","facility":"JC","address":"경북 고령군 성산면 박곡리 647","lat":35.758949,"lon":128.379322,"cctvId":"cctv00003535","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":102,"cctvId":"cctv00003535"},{"dir":"G","seq":103,"cctvId":"cctv00003535"}],"id":"p52","zone":"230","nearZones":["220"]},{"name":"논공휴게소","km":169.2,"kmSource":"공식","facility":"휴게소","address":"대구 달성군 논공읍 삼리리 458-4","lat":35.766174,"lon":128.402933,"cctvId":"cctv00003534","note":"","cams":[{"dir":"D","seq":104,"cctvId":"cctv00003534"},{"dir":"G","seq":105,"cctvId":"cctv00003534"}],"id":"p53","zone":"230"},{"name":"논공휴게소2","km":169.4,"kmSource":"산출","facility":"휴게소","address":"대구 달성군 논공읍 삼리리 458-4","lat":35.766936,"lon":128.40415,"cctvId":"cctv00000147","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":106,"cctvId":"cctv00000147"},{"dir":"G","seq":107,"cctvId":"cctv00000147"}],"id":"p54","zone":"230"},{"name":"금포2교","km":170.99,"kmSource":"공식","facility":"교량","address":"대구 달성군 논공읍 금포리 산 8-1","lat":35.769926,"lon":128.417653,"cctvId":"cctv00006019","note":"","cams":[{"dir":"D","seq":108,"cctvId":"cctv00006019"},{"dir":"G","seq":109,"cctvId":"cctv00006019"}],"id":"p55","zone":"230"},{"name":"논공교","km":171.84,"kmSource":"공식","facility":"교량","address":"대구 달성군 논공읍 금포리 산 35-11","lat":35.770323,"lon":128.43169,"cctvId":"cctv00003533","note":"","cams":[{"dir":"D","seq":114,"cctvId":"cctv00003533"},{"dir":"G","seq":115,"cctvId":"cctv00003533"}],"id":"p56","zone":"230"},{"name":"논공교2","km":171.84,"kmSource":"공식","facility":"교량","address":"대구 달성군 논공읍 금포리 1665-4","lat":35.767748,"lon":128.426271,"cctvId":"cctv00000191","note":"논공교 일대 개별 카메라(개별 이정은 미고시)","cams":[{"dir":"D","seq":110,"cctvId":"cctv00000191"},{"dir":"G","seq":111,"cctvId":"cctv00000191"}],"id":"p57","zone":"230"},{"name":"논공교3","km":171.84,"kmSource":"공식","facility":"교량","address":"대구 달성군 논공읍 금포리 1635-1","lat":35.768671,"lon":128.428551,"cctvId":"cctv00005595","note":"논공교 일대 개별 카메라(개별 이정은 미고시)","cams":[{"dir":"D","seq":112,"cctvId":"cctv00005595"},{"dir":"G","seq":113,"cctvId":"cctv00005595"}],"id":"p58","zone":"230"},{"name":"논공교4","km":171.84,"kmSource":"공식","facility":"교량","address":"대구 달성군 옥포읍 강림리 1076-4","lat":35.774703,"lon":128.437564,"cctvId":"cctv00000192","note":"논공교 일대 개별 카메라(개별 이정은 미고시)","cams":[{"dir":"D","seq":116,"cctvId":"cctv00000192"},{"dir":"G","seq":117,"cctvId":"cctv00000192"}],"id":"p59","zone":"230"},{"name":"금포리","km":172.14,"kmSource":"산출","facility":"일반(마을)","address":"대구 달성군 논공읍 금포리 산 39-5","lat":35.774215,"lon":128.437093,"cctvId":"cctv00000111","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":118,"cctvId":"cctv00000111"},{"dir":"G","seq":119,"cctvId":"cctv00000111"}],"id":"p60","zone":"230"},{"name":"금포리2","km":172.71,"kmSource":"산출","facility":"일반(마을)","address":"대구 달성군 옥포읍 교항리 산 161-3","lat":35.778109,"lon":128.444047,"cctvId":"cctv00001459","note":"이정 산출(좌표→노선 투영, 오차 ±0.5km)","cams":[{"dir":"D","seq":120,"cctvId":"cctv00001459"},{"dir":"G","seq":121,"cctvId":"cctv00001459"}],"id":"p61","zone":"230"},{"name":"옥포분기점_광주대구","km":176.0,"kmSource":"공식","facility":"JC","address":"대구 달성군 옥포읍 교항리 산 139-1","lat":35.781373,"lon":128.451706,"cctvId":"cctv00003532","note":"","cams":[{"dir":"D","seq":122,"cctvId":"cctv00003532"},{"dir":"G","seq":123,"cctvId":"cctv00003532"}],"id":"p62","zone":"230"}],"bridgeKm":4.0};
/* @MASTER_END */

/* ─────────────────────────── 유틸 ─────────────────────────── */

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function httpError(code, message, detail = {}) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail;
  return err;
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** CCTV 이름 비교용 정규화: 괄호 주석·공백 제거, 소문자 */
function normalizeName(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isRefresh(url) {
  const value = url.searchParams.get('refresh');
  return value === '1' || value === 'true';
}

/** 캐시 계층: Cloudflare Cache API → 같은 isolate 메모 → 없음 */
const MEMO = (globalThis.__GDC_MEMO = globalThis.__GDC_MEMO || new Map());

function cacheStore() {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

async function cacheRead(key) {
  const store = cacheStore();
  if (store) {
    try {
      const hit = await store.match(new Request(`https://cache.gdc.invalid/${key}`));
      if (hit) return await hit.json();
    } catch (e) {
      /* 캐시가 깨졌으면 무시하고 새로 만듭니다. */
    }
  }
  const memo = MEMO.get(key);
  if (memo && memo.expires > Date.now()) return memo.data;
  return null;
}

async function cacheWrite(key, data, ttl) {
  const store = cacheStore();
  if (store) {
    try {
      await store.put(
        new Request(`https://cache.gdc.invalid/${key}`),
        new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` },
        })
      );
    } catch (e) {
      /* 저장 실패는 응답에 영향을 주지 않습니다. */
    }
  }
  MEMO.set(key, { data, expires: Date.now() + ttl * 1000 });
}

/**
 * 캐시 조회 → 없으면 build() 실행 → 저장.
 * refresh=true 이면 캐시를 건너뜁니다.
 */
async function withCache(key, ttl, refresh, build) {
  if (!refresh) {
    const hit = await cacheRead(key);
    if (hit) return { data: hit, cache: 'HIT' };
  }
  const data = await build();
  await cacheWrite(key, data, ttl);
  return { data, cache: refresh ? 'REFRESH' : 'MISS' };
}

/* ─────────────────────── 업스트림 공통 호출 ─────────────────────── */

async function fetchJson(url, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS, label = 'upstream', retries = 0) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJsonOnce(url, init, timeoutMs, label);
    } catch (err) {
      lastError = err;
      const code = err && err.code;
      const retryable = code === 'UPSTREAM_UNREACHABLE' || code === 'UPSTREAM_TIMEOUT' || code === 'UPSTREAM_HTTP_ERROR';
      if (!retryable || attempt === retries) throw err;
      // 로드플러스·기상청 서버가 간헐적으로 연결을 거부합니다. 짧게 쉬고 한 번 더.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

async function fetchJsonOnce(url, init, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: init.method || 'GET',
      headers: { Accept: 'application/json', ...(init.headers || {}) },
      body: init.body,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw httpError('UPSTREAM_HTTP_ERROR', `${label}가 HTTP ${res.status}로 응답했습니다.`, {
        status: res.status,
        sample: body.slice(0, 300),
      });
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (parseError) {
      throw httpError('UPSTREAM_BAD_JSON', `${label} 응답을 JSON으로 해석하지 못했습니다.`, {
        sample: text.slice(0, 200),
      });
    }
  } catch (err) {
    // DOMException(중단)은 code 가 숫자(20=ABORT_ERR)라 아래 httpError 의 code 검사에 걸립니다.
    // 먼저 중단 여건을 판정해야 타임아웃이 UNKNOWN(20) 대신 UPSTREAM_TIMEOUT 으로 분류되고
    // fetchJson 의 재시도도 동작합니다.
    const aborted = controller.signal.aborted || (err && err.name === 'AbortError');
    if (!aborted && err && err.code) throw err;
    throw httpError(
      aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      aborted
        ? `${label} 응답이 ${timeoutMs / 1000}초 안에 오지 않았습니다.`
        : `${label}에 연결하지 못했습니다.`,
      { cause: String((err && err.message) || err) }
    );
  } finally {
    clearTimeout(timer);
  }
}

function postForm(url, params, timeoutMs, label) {
  const body = new URLSearchParams(params).toString();
  return fetchJson(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body },
    timeoutMs,
    label
  );
}

/* ─────────────────────── ITS 응답 해석 (/api/cctv) ─────────────────────── */

/**
 * ITS 응답은 문서·버전에 따라 item 배열 위치가 다릅니다.
 *   { response: { body: { items: { item: [...] } } } }
 *   { response: { data: [...] } }
 *   { items: [...] } / [...] 등
 * cctvurl을 가진 객체 배열을 찾아낼 때까지 훑습니다.
 */
function findCctvArray(node, depth = 0) {
  const looksLikeCctv = (item) =>
    item &&
    typeof item === 'object' &&
    (firstString(item, ['cctvurl', 'cctvUrl']) || (item.url && (item.name || item.cctvname)));

  if (Array.isArray(node)) {
    return node.some(looksLikeCctv) ? node : null;
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

function readResultHeader(json) {
  const header = json && json.response && json.response.header;
  if (!header) return null;
  return {
    code: firstString(header, ['resultCode', 'resultcode', 'code']),
    message: firstString(header, ['resultMsg', 'resultmsg', 'message']),
  };
}

function normalizeCctv(item) {
  const url = firstString(item, ['cctvurl', 'cctvUrl', 'url']);
  if (!url) return null;
  const name = firstString(item, ['cctvname', 'cctvName', 'name']);
  const format = firstString(item, ['cctvformat', 'cctvFormat', 'format']);
  return {
    name: name || '(이름 없음)',
    url,
    format: format || (url.includes('.m3u8') ? 'HLS' : 'MP4'),
    x: toNumber(firstString(item, ['coordx', 'coordX'])),
    y: toNumber(firstString(item, ['coordy', 'coordY'])),
  };
}

function buildItsUrl(apiKey) {
  const url = new URL(ITS_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('type', 'ex');
  url.searchParams.set('cctvType', '1');
  url.searchParams.set('minX', String(BOUNDS.minX));
  url.searchParams.set('maxX', String(BOUNDS.maxX));
  url.searchParams.set('minY', String(BOUNDS.minY));
  url.searchParams.set('maxY', String(BOUNDS.maxY));
  url.searchParams.set('getType', 'json');
  return url.toString();
}

async function fetchItsList(env) {
  const customSource = String(env.CCTV_SOURCE_URL || '').trim();
  const apiKey = String(env.ITS_API_KEY || '').trim();

  if (!customSource && !apiKey) {
    throw httpError('ITS_API_KEY_MISSING', 'ITS_API_KEY 시크릿이 설정되지 않았습니다.', {
      howTo: [
        '배포: wrangler secret put ITS_API_KEY  (발급받은 키 붙여넣기)',
        '로컬: 프로젝트 루트 .dev.vars 파일에 ITS_API_KEY=발급받은키 한 줄 추가 후 wrangler dev',
        '이 키는 코드에 하드코딩하지 마세요. 저장소에 커밋되면 즉시 노출됩니다.',
      ],
    });
  }

  // ITS 목록은 가끔 15초 안에 응답하지 않습니다. 한 번은 짧게 쉬고 다시 시도해
  // 대시보드가 'CCTV 목록 오류'로 비지 않게 합니다.
  const json = await fetchJson(customSource || buildItsUrl(apiKey), {}, UPSTREAM_TIMEOUT_MS, 'ITS Open API', 1);
  return { json, source: customSource ? 'CCTV_SOURCE_URL' : 'ITS 국가교통정보센터 Open API' };
}

/**
 * 123대 마스터(points) 기준으로 ITS 목록을 매칭합니다.
 * 같은 이름이 여러 지점에 있으면(예: 논공교2) 후보를 모두 붙입니다.
 */
function matchToMaster(cctvs) {
  const byName = new Map();
  for (const cctv of cctvs) {
    const key = normalizeName(cctv.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(cctv);
  }

  const used = new Set();
  const points = MASTER.points.map((point) => {
    const key = normalizeName(point.name);
    const exact = byName.get(key) || [];
    // 괄호 주석·공백을 지운 정확 일치만 매칭합니다. ITS 이름의 (외부) 같은 주석은
    // 이미 정규화에서 빠지므로, '함양'이 '함양산삼골휴게소'에 끌려가지 않습니다.
    const matched = byName.get(key) || [];
    const items = matched.map((c) => {
      used.add(c);
      return { name: c.name, url: c.url, format: c.format, mode: 'exact' };
    });
    return {
      ...point,
      its: items,
      itsMode: items.length ? 'exact' : 'none',
    };
  });

  const unmatched = [...new Set(cctvs.filter((c) => !used.has(c)).map((c) => c.name))].sort((a, b) =>
    a.localeCompare(b, 'ko')
  );

  return { points, unmatched };
}

async function buildCctvPayload(env) {
  const { json, source } = await fetchItsList(env);

  const rawItems = findCctvArray(json) || [];
  const cctvs = [];
  const seen = new Set();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const cctv = normalizeCctv(item);
    if (!cctv) continue;
    const key = `${cctv.name}|${cctv.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cctvs.push(cctv);
  }

  if (cctvs.length === 0) {
    const header = readResultHeader(json);
    if (header && header.code && !['0', '00', '000', 'SUCCESS'].includes(header.code.toUpperCase())) {
      throw httpError('ITS_API_ERROR', `ITS API가 오류를 반환했습니다. (${header.code})`, {
        resultCode: header.code,
        resultMsg: header.message,
      });
    }
  }

  cctvs.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const { points, unmatched } = matchToMaster(cctvs);

  const matchedPoints = points.filter((p) => p.its.length > 0).length;
  const matchedCameras = points.reduce((sum, p) => sum + p.its.length, 0);

  return {
    ok: true,
    kind: 'cctv',
    source,
    bounds: BOUNDS,
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL.cctv,
    count: cctvs.length,
    cctvs,
    route: { name: MASTER.route, no: MASTER.routeNo, range: MASTER.range },
    points,
    stats: {
      itsCctvCount: cctvs.length,
      masterPoints: points.length,
      masterCameras: points.reduce((sum, p) => sum + p.cams.length, 0),
      matchedPoints,
      matchedCctvItems: matchedCameras,
      pointsWithoutIts: points.filter((p) => p.its.length === 0).map((p) => p.name),
      itsUnmatchedNames: unmatched,
      // 이전 팝업 대시보드(downloads/cctv_popup_dashboard.html) 호환용 별명
      unmatchedLabels: unmatched,
    },
  };
}

/* ─────────────────────── RWIS (/api/rwis) ─────────────────────── */

function rwisBase(env) {
  const base = String(env.RWIS_BASE || 'https://rwis.kma.go.kr').trim().replace(/\/+$/, '');
  return base;
}

function conzoneIdFor(dirCode, suffix) {
  // 예: E + 170 → 0120CZE170
  return `0120CZ${dirCode}${suffix}`;
}

/** ① 노선의 IC~IC 구간과 구간별 LINK_ID 목록 */
async function fetchConzones(env) {
  const base = rwisBase(env);
  const url = `${base}/comis5/uis/gis/api/getConZoneByRoadNo.do`;
  const map = new Map();

  const results = await Promise.all(
    RWIS_DIRS.map((dir) =>
      postForm(
        url,
        {
          roadNo: ROAD.roadNo,
          roadNoN1: ROAD.roadNoN1,
          roadNoN2: ROAD.roadNoN2,
          cdpntTmnlDirDvCd: dir.code,
        },
        UPSTREAM_TIMEOUT_MS,
        `RWIS 구간조회(${dir.code})`
      )
    )
  );

  results.forEach((res, index) => {
    const dir = RWIS_DIRS[index];
    const items = Array.isArray(res && res.data) ? res.data : [];
    if (!items.length) {
      throw httpError('RWIS_NO_CONZONE', 'RWIS 구간 조회 결과가 비어 있습니다.', { dir: dir.code });
    }
    for (const item of items) {
      const id = firstString(item, ['conzoneId']);
      if (!id) continue;
      map.set(id, {
        id,
        dir: dir.code,
        name: firstString(item, ['conzoneNm']),
        len: toNumber(firstString(item, ['conzoneLen'])),
        links: (firstString(item, ['linkIdArrStr']) || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
    }
  });

  return map;
}

/** ② 최신 유효 기준시각 nrmMaxTm (YYYYMMDDHHmm) */
async function fetchRiskTm(env, riskCd) {
  const base = rwisBase(env);
  const json = await fetchJson(
    `${base}/rrw/algo/info/getNrmRoadRiskTimeSet?riskCd=${encodeURIComponent(riskCd)}`,
    {},
    UPSTREAM_TIMEOUT_MS,
    `RWIS 기준시각(${riskCd})`
  );
  const items = (json && json.body && json.body.items) || [];
  const tm = firstString(items[0] || {}, ['nrmMaxTm']);
  if (!/^\d{12}$/.test(tm)) {
    throw httpError('RWIS_NO_TM', 'RWIS 최신 기준시각(nrmMaxTm)을 받지 못했습니다.', { riskCd, body: json });
  }
  return tm;
}

/** 최신 5분 슬롯 표가 아직 안 올라왔을 때(NODATA_ERROR·빈 표) 5분씩 직전 슬롯으로 후퇴하는 한도 */
const RWIS_SLOT_MINUTES = 5;
const RWIS_FALLBACK_STEPS = 4; // 최신 + 4단계 = 최대 20분 전까지

/** 202611230935 에서 분 단위로 이동한 관측시각 (UTC 연산 — 표기만 KST) */
function shiftTm(tm, minutes) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(tm || ''));
  if (!m) return String(tm || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** ③-1 한 슬롯의 표(약 5.6MB, 전국 ~4만 링크)를 스트리밍으로 훑어 대상 LINK_ID(~100개)만 파싱한다.
 *  전체 JSON.parse(수만 객체 할당)를 생략해 Cloudflare Workers 무료 플랜 CPU·메모리 피크를 90%+ 절감한다.
 */
function createRiskTableScanner(field, wantedLinks) {
  const levels = new Map();
  let code = '';
  let itemCount = 0;
  let inItems = false;
  let doneItems = false;
  let buf = '';
  const idRe = /"(?:LINK_ID|linkId)"\s*:\s*"?([^",\s}]+)"?/;
  const codeRe = /"(?:resultCode|resultcode|code)"\s*:\s*"([^"]+)"/;

  const processObj = (objText) => {
    itemCount += 1;
    const idMatch = idRe.exec(objText);
    if (!idMatch) return;
    const id = idMatch[1];
    if (!wantedLinks.has(id)) return;
    try {
      const item = JSON.parse(objText);
      const raw = item[field];
      if (raw === null || raw === undefined || raw === '') return;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 3) return;
      levels.set(id, Math.round(value));
    } catch {}
  };

  const push = (chunk) => {
    if (!chunk || doneItems) return;
    buf += chunk;
    if (!code) {
      const cm = codeRe.exec(buf);
      if (cm) code = cm[1];
    }
    if (!inItems) {
      const itemsIdx = buf.indexOf('"items"');
      if (itemsIdx < 0) {
        if (buf.length > 512) buf = buf.slice(-64);
        return;
      }
      const arrIdx = buf.indexOf('[', itemsIdx + 7);
      if (arrIdx < 0) {
        buf = buf.slice(itemsIdx);
        return;
      }
      inItems = true;
      buf = buf.slice(arrIdx + 1);
    }

    let pos = 0;
    const len = buf.length;
    while (pos < len) {
      const openIdx = buf.indexOf('{', pos);
      const closeArrIdx = buf.indexOf(']', pos);
      if (closeArrIdx >= 0 && (openIdx < 0 || closeArrIdx < openIdx)) {
        doneItems = true;
        buf = '';
        return;
      }
      if (openIdx < 0) {
        buf = '';
        return;
      }
      const closeIdx = buf.indexOf('}', openIdx + 1);
      if (closeIdx < 0) {
        buf = buf.slice(openIdx);
        return;
      }
      processObj(buf.slice(openIdx, closeIdx + 1));
      pos = closeIdx + 1;
    }
    buf = '';
  };

  return {
    push,
    result: (tm) => ({ levels, tm, code, itemCount, empty: levels.size === 0 }),
  };
}

async function fetchRiskTableSlot(env, riskCd, tm, field, wantedLinks) {
  const base = rwisBase(env);
  const url = `${base}/rrw/algo/data/getNrmRiskRoadTableAll?riskCd=${encodeURIComponent(riskCd)}&tm=${encodeURIComponent(tm)}`;
  const label = `RWIS 위험표(${riskCd})`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw httpError('UPSTREAM_HTTP_ERROR', `${label}가 HTTP ${res.status}로 응답했습니다.`, {
        status: res.status,
        sample: body.slice(0, 300),
      });
    }

    const scanner = createRiskTableScanner(field, wantedLinks);
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) scanner.push(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) scanner.push(tail);
      return scanner.result(tm);
    }

    const text = await res.text();
    scanner.push(text);
    const scanned = scanner.result(tm);
    if (scanned.itemCount > 0 || scanned.code) return scanned;

    // 예외적인 JSON 구조 폴백
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw httpError('UPSTREAM_BAD_JSON', `${label} 응답을 JSON으로 해석하지 못했습니다.`, {
        sample: text.slice(0, 200),
      });
    }
    const header = (json && json.header) || {};
    const code = firstString(header, ['resultCode', 'resultcode', 'code']);
    const items = (json && json.body && json.body.items) || [];
    const levels = new Map();
    if (Array.isArray(items)) {
      for (const item of items) {
        const id = firstString(item, ['LINK_ID', 'linkId']);
        if (!id || !wantedLinks.has(id)) continue;
        const raw = item[field];
        if (raw === null || raw === undefined || raw === '') continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 3) continue;
        levels.set(id, Math.round(value));
      }
    }
    return { levels, tm, code, itemCount: Array.isArray(items) ? items.length : 0, empty: levels.size === 0 };
  } catch (err) {
    const aborted = controller.signal.aborted || (err && err.name === 'AbortError');
    if (!aborted && err && err.code) throw err;
    throw httpError(
      aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      aborted ? `${label} 응답이 ${UPSTREAM_TIMEOUT_MS / 1000}초 안에 오지 않았습니다.` : `${label} 서버에 연결할 수 없습니다.`,
      { cause: String(err && err.message ? err.message : err) }
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ③ 위험등급 표 → 대상 LINK_ID만 추출. 최신 슬롯이 비면 5분씩 직전 슬롯으로 후퇴합니다.
 * 기상청 표는 nrmMaxTm 보다 몇 분 늦게 올라오는 일이 있고, 그때 HTTP 200 + resultCode 03
 * (NODATA_ERROR) + 빈 items 로 돌아옵니다. 실제 사용한 관측시각을 tm 으로 돌려줍니다.
 */
async function fetchRiskTable(env, riskCd, tm, field, wantedLinks) {
  const tried = [];
  for (let step = 0; step <= RWIS_FALLBACK_STEPS; step += 1) {
    const slot = shiftTm(tm, -RWIS_SLOT_MINUTES * step);
    const result = await fetchRiskTableSlot(env, riskCd, slot, field, wantedLinks);
    if (!result.empty) return { ...result, latest: tm, steps: step, tried };
    tried.push({ tm: slot, resultCode: result.code || null, items: result.itemCount });
  }
  throw httpError(
    'RWIS_EMPTY_TABLE',
    `RWIS 위험등급 표가 비어 있습니다. 최근 ${RWIS_FALLBACK_STEPS + 1}개 슬롯(${
      RWIS_FALLBACK_STEPS * RWIS_SLOT_MINUTES
    }분 전까지) 모두 비었습니다.`,
    { riskCd, latest: tm, tried }
  );
}

function levelCounts(levelsByLink, links) {
  const counts = [0, 0, 0, 0];
  let known = 0;
  let max = null;
  for (const link of links) {
    if (!levelsByLink.has(link)) continue;
    const level = levelsByLink.get(link);
    counts[level] += 1;
    known += 1;
    if (max === null || level > max) max = level;
  }
  return { level: max, counts: known ? counts : null, known, total: links.length };
}

function riskView(info) {
  return {
    level: info.level,
    levelName: info.level === null ? '결측' : LEVEL_NAME[info.level],
    levelDetail: info.level === null ? '등급 없음' : LEVEL_DETAIL[info.level],
    counts: info.counts, // [0단계,1단계,2단계,3단계] 링크 수
    knownLinks: info.known,
    totalLinks: info.total,
  };
}

async function buildRwisPayload(env) {
  const sourceUrl = String(env.RWIS_SOURCE_URL || '').trim();
  if (sourceUrl) return buildRwisFromSource(sourceUrl);

  const zoneDefs = [];
  for (const zone of MASTER.zones) {
    for (const dir of RWIS_DIRS) {
      const id = conzoneIdFor(dir.code, zone.suffix);
      zoneDefs.push({ id, zone, dir });
    }
  }

  // 구간(conzone) 목록은 Map 이라 그대로 캐시에 넣으면 JSON 직렬화에서 {} 로 깨어집니다.
  // (엣지 캐시에서 되살아난 값에 .get 이 없어 'conzones.get is not a function' 으로 죽던 원인)
  // 캐시에는 [id, conzone] 배열로만 넣고, 읽을 때 Map 으로 되살립니다.
  const { data: conzoneRows } = await withCache('rwis:conzones:v2', CACHE_TTL.conzone, false, async () =>
    [...(await fetchConzones(env)).entries()]
  );
  const conzones = conzoneRows instanceof Map
    ? conzoneRows
    : new Map(Array.isArray(conzoneRows) ? conzoneRows : []);

  const wantedLinks = new Set();
  for (const def of zoneDefs) {
    const conzone = conzones.get(def.id);
    if (conzone) for (const link of conzone.links) wantedLinks.add(link);
  }

  const [frLatest, vrLatest] = await Promise.all([fetchRiskTm(env, 'FR'), fetchRiskTm(env, 'VR')]);
  const [frTable, vrTable] = await Promise.all([
    fetchRiskTable(env, 'FR', frLatest, 'FSM', wantedLinks),
    fetchRiskTable(env, 'VR', vrLatest, 'VIR', wantedLinks),
  ]);
  const frLevels = frTable.levels;
  const vrLevels = vrTable.levels;
  // tm 은 실제로 등급을 읽어 온 관측시각(후퇴했으면 그 슬롯)
  const frTm = frTable.tm;
  const vrTm = vrTable.tm;

  const zones = zoneDefs.map(({ id, zone, dir }) => {
    const conzone = conzones.get(id) || null;
    const links = conzone ? conzone.links : [];
    const fsm = riskView(levelCounts(frLevels, links));
    const vir = riskView(levelCounts(vrLevels, links));
    return {
      id,
      suffix: zone.suffix,
      name: conzone ? conzone.name || zone.name : zone.name,
      dir: dir.code,
      dirLabel: dir.label,
      dirShort: dir.short,
      startKm: zone.startKm,
      endKm: zone.endKm,
      lengthM: conzone ? conzone.len : null,
      linkCount: links.length,
      missing: !conzone,
      fsm,
      vir,
    };
  });

  const summary = {
    fsmMax: zones.reduce((m, z) => (z.fsm.level === null ? m : Math.max(m ?? 0, z.fsm.level)), null),
    virMax: zones.reduce((m, z) => (z.vir.level === null ? m : Math.max(m ?? 0, z.vir.level)), null),
    fsmZoneCounts: [0, 1, 2, 3].map((level) => zones.filter((z) => z.fsm.level === level).length),
    virZoneCounts: [0, 1, 2, 3].map((level) => zones.filter((z) => z.vir.level === level).length),
    missingZones: zones.filter((z) => z.missing).map((z) => z.id),
    zonesWithoutData: zones.filter((z) => !z.missing && z.fsm.level === null && z.vir.level === null).map((z) => z.id),
  };

  const alerts = zones
    .filter((z) => (z.fsm.level !== null && z.fsm.level >= 2) || (z.vir.level !== null && z.vir.level >= 2))
    .map((z) => ({
      id: z.id,
      name: z.name,
      dirLabel: z.dirLabel,
      fsm: z.fsm.level,
      vir: z.vir.level,
      text:
        `${z.name}(${z.dirLabel}) ` +
        [z.fsm.level >= 2 ? `도로살얼음 ${LEVEL_NAME[z.fsm.level]}` : null, z.vir.level >= 2 ? `가시거리 ${LEVEL_NAME[z.vir.level]}` : null]
          .filter(Boolean)
          .join(' · '),
    }));

  return {
    ok: true,
    kind: 'rwis',
    source: 'rwis.kma.go.kr 도로기상정보시스템',
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL.rwis,
    road: { no: ROAD.roadNo, n2: ROAD.roadNoN2, name: ROAD.name, range: MASTER.range },
    tm: { FR: frTm, VR: vrTm },
    tmLabel: { FR: formatTm(frTm), VR: formatTm(vrTm) },
    tmLatest: { FR: frLatest, VR: vrLatest },
    tmFallbackSteps: { FR: frTable.steps, VR: vrTable.steps },
    tmFallback: {
      FR: frTable.steps > 0,
      VR: vrTable.steps > 0,
      note:
        frTable.steps > 0 || vrTable.steps > 0
          ? `최신 기준시각 표가 아직 없어 ${RWIS_SLOT_MINUTES}분 단위로 직전 슬롯을 씁니다.`
          : null,
    },
    levelNames: LEVEL_NAME,
    levelDetails: LEVEL_DETAIL,
    summary,
    alerts,
    zones,
  };
}

/**
 * 사전 계산 JSON(RWIS_SOURCE_URL) 사용 경로.
 * 표 전체(약 2.8MB×2) 파싱을 Worker가 하지 않으므로 무료 플랜 CPU 한도에서도 안전합니다.
 * JSON 형식은 tools/rwis_export.py 출력(= /api/rwis 응답 형태)과 같습니다.
 */
async function buildRwisFromSource(sourceUrl) {
  const json = await fetchJson(sourceUrl, {}, UPSTREAM_TIMEOUT_MS, 'RWIS_SOURCE_URL');
  const zones = json && json.zones;
  if (!Array.isArray(zones) || zones.length === 0 || !json.tm) {
    throw httpError('RWIS_SOURCE_BAD_SHAPE', 'RWIS_SOURCE_URL 응답이 예상 형식(16개 zones + tm)이 아닙니다.', {
      got: json ? Object.keys(json) : null,
    });
  }
  return {
    ...json,
    ok: true,
    kind: 'rwis',
    via: 'source-url',
    source: json.source || 'RWIS_SOURCE_URL(사전 계산)',
    fetchedAt: json.generatedAt || new Date().toISOString(),
  };
}

/** 202611210020 → 2026-11-21 00:20 (KST) */
function formatTm(tm) {
  const s = String(tm || '');
  if (!/^\d{12}$/.test(s)) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

/* ─────────────────────── 스트림 주소 (/api/stream) ─────────────────────── */

async function buildStreamPayload(cctvId) {
  const url = `${ROADPLUS_ENDPOINT}?cctvId=${encodeURIComponent(cctvId)}`;
  const json = await fetchJson(url, {}, ROADPLUS_TIMEOUT_MS, '로드플러스 CCTV API', 1);
  const info = json && Array.isArray(json.cctvInfo) ? json.cctvInfo[0] : null;
  if (!info || !info.CCTVURL) {
    throw httpError('STREAM_NOT_FOUND', '로드플러스에서 이 CCTV의 영상 주소를 받지 못했습니다.', {
      cctvId,
      got: json ? Object.keys(json) : null,
    });
  }
  return {
    ok: true,
    kind: 'stream',
    cctvId,
    name: firstString(info, ['CCTV_NM']),
    streamUrl: firstString(info, ['CCTVURL']),
    snapshotUrl: firstString(info, ['NOWCCTVIMG']),
    prev: { cctvId: firstString(info, ['PREV_CCTV_ID']), name: firstString(info, ['PREVCCTVNM']) },
    next: { cctvId: firstString(info, ['NEXT_CCTV_ID']), name: firstString(info, ['NEXTCCTVNM']) },
    camId: toNumber(info.CAMRID),
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL.stream,
  };
}

/* ─────────────────────────── 핸들러 ─────────────────────────── */

function errorPayload(err, kind) {
  const code = (err && err.code) || 'UNKNOWN_ERROR';
  return {
    ok: false,
    kind,
    error: code,
    message: (err && err.message) || '알 수 없는 오류',
    detail: (err && err.detail) || null,
    at: new Date().toISOString(),
  };
}

function hintsFor(code, kind) {
  if (kind === 'cctv') {
    if (code === 'ITS_API_KEY_MISSING') return 'Worker 시크릿 ITS_API_KEY를 설정한 뒤 다시 호출하세요. (wrangler secret put ITS_API_KEY)';
    return 'Cloudflare Workers에서 openapi.its.go.kr:9443 연결이 막히는 경우가 있습니다. 그때는 NAS나 GitHub Actions에서 같은 JSON을 주기적으로 받아 KV/R2/정적 호스팅에 올리고, Worker 환경변수 CCTV_SOURCE_URL 에 그 주소를 지정하세요. (README.md 참고)';
  }
  if (kind === 'rwis') {
    return 'rwis.kma.go.kr 응답이 일시적으로 비어 있을 수 있습니다. 잠시 뒤 ?refresh=1 로 다시 호출해 보세요. 계속 실패하면 RWIS_BASE 환경변수와 기상청 점검 공지를 확인하세요. (무료 플랜 CPU 한도가 걱정되면 tools/rwis_export.py + RWIS_SOURCE_URL 방식을 쓰세요 — README 4장)';
  }
  return null;
}

async function handleCctv(url, env) {
  const refresh = isRefresh(url);
  try {
    const { data, cache } = await withCache('cctv:v2', CACHE_TTL.cctv, refresh, () => buildCctvPayload(env));
    return jsonResponse({ ...data, cache }, 200, {
      'X-Cache': cache,
      'Cache-Control': `public, max-age=${CACHE_TTL.cctv}`,
    });
  } catch (err) {
    const code = (err && err.code) || 'UNKNOWN_ERROR';
    const status = code === 'ITS_API_KEY_MISSING' ? 500 : 502;
    return jsonResponse(
      { ...errorPayload(err, 'cctv'), hint: hintsFor(code, 'cctv') },
      status,
      { 'X-Cache': 'BYPASS' }
    );
  }
}

async function handleRwis(url, env) {
  const refresh = isRefresh(url);
  try {
    const { data, cache } = await withCache('rwis:v2:all', CACHE_TTL.rwis, refresh, () => buildRwisPayload(env));
    return jsonResponse({ ...data, cache }, 200, {
      'X-Cache': cache,
      'Cache-Control': `public, max-age=${CACHE_TTL.rwis}`,
    });
  } catch (err) {
    const code = (err && err.code) || 'UNKNOWN_ERROR';
    return jsonResponse(
      { ...errorPayload(err, 'rwis'), hint: hintsFor(code, 'rwis') },
      502,
      { 'X-Cache': 'BYPASS' }
    );
  }
}

async function handleStatus(url, env) {
  const refresh = isRefresh(url);
  const [cctvResult, rwisResult] = await Promise.allSettled([
    withCache('cctv:v2', CACHE_TTL.cctv, refresh, () => buildCctvPayload(env)),
    withCache('rwis:v2:all', CACHE_TTL.rwis, refresh, () => buildRwisPayload(env)),
  ]);

  const errors = {};
  let cctv = null;
  let rwis = null;

  if (cctvResult.status === 'fulfilled') {
    cctv = { ...cctvResult.value.data, cache: cctvResult.value.cache };
  } else {
    const err = cctvResult.reason;
    errors.cctv = { ...errorPayload(err, 'cctv'), hint: hintsFor((err && err.code) || '', 'cctv') };
  }

  if (rwisResult.status === 'fulfilled') {
    rwis = { ...rwisResult.value.data, cache: rwisResult.value.cache };
  } else {
    const err = rwisResult.reason;
    errors.rwis = { ...errorPayload(err, 'rwis'), hint: hintsFor((err && err.code) || '', 'rwis') };
  }

  const ok = Boolean(cctv || rwis);
  return jsonResponse(
    {
      ok,
      version: VERSION,
      fetchedAt: new Date().toISOString(),
      master: { route: MASTER.route, no: MASTER.routeNo, range: MASTER.range, zones: MASTER.zones },
      cctv,
      rwis,
      errors,
    },
    ok ? 200 : 502,
    { 'X-Cache': refresh ? 'REFRESH' : 'MIXED' }
  );
}

async function handleStream(url, env) {
  const cctvId = String(url.searchParams.get('cctvId') || '').trim().toLowerCase();
  if (!/^cctv\d{8}$/.test(cctvId)) {
    return jsonResponse(
      {
        ok: false,
        kind: 'stream',
        error: 'INVALID_CCTV_ID',
        message: 'cctvId는 cctv + 8자리 숫자 형식이어야 합니다. 예: ?cctvId=cctv00005751',
      },
      400
    );
  }

  const refresh = isRefresh(url);
  try {
    const { data, cache } = await withCache(`stream:v1:${cctvId}`, CACHE_TTL.stream, refresh, () =>
      buildStreamPayload(cctvId)
    );
    return jsonResponse({ ...data, cache }, 200, {
      'X-Cache': cache,
      'Cache-Control': `public, max-age=${CACHE_TTL.stream}`,
    });
  } catch (err) {
    return jsonResponse(
      {
        ...errorPayload(err, 'stream'),
        hint: '로드플러스 CCTV API가 일시적으로 응답하지 않을 수 있습니다. 잠시 뒤 다시 시도하세요.',
      },
      502,
      { 'X-Cache': 'BYPASS' }
    );
  }
}

function handleIndex(env) {
  const cameraCount = MASTER.points.reduce((sum, p) => sum + p.cams.length, 0);
  return jsonResponse({
    ok: true,
    service: '광주대구선 CCTV + RWIS 통합 Worker',
    version: VERSION,
    route: { name: MASTER.route, no: MASTER.routeNo, range: MASTER.range },
    master: { points: MASTER.points.length, cameras: cameraCount, rwisZones: MASTER.zones.length * RWIS_DIRS.length },
    endpoints: {
      'GET /api/status': 'CCTV(123대) + RWIS(16개 구간) 통합 응답 (권장)',
      'GET /api/cctv': 'ITS Open API CCTV 목록 + 123대 마스터 매칭 (15분 캐시)',
      'GET /api/cctv?refresh=1': '캐시를 무시하고 ITS에서 즉시 갱신',
      'GET /api/rwis': 'RWIS 도로살얼음(FSM)·가시거리(VIR) 16개 구간 등급 (5분 캐시)',
      'GET /api/rwis?refresh=1': 'RWIS 캐시 무시',
      'GET /api/stream?cctvId=cctv00005751': '로드플러스 CCTV HLS 주소 + 스냅샷 (2분 캐시)',
      'OPTIONS *': 'CORS preflight',
    },
    coverage: BOUNDS,
    env: {
      ITS_API_KEY: Boolean(String(env.ITS_API_KEY || '').trim()),
      CCTV_SOURCE_URL: Boolean(String(env.CCTV_SOURCE_URL || '').trim()),
      RWIS_SOURCE_URL: Boolean(String(env.RWIS_SOURCE_URL || '').trim()),
      RWIS_BASE: String(env.RWIS_BASE || 'https://rwis.kma.go.kr'),
      rwisMode: String(env.RWIS_SOURCE_URL || '').trim() ? 'source-url(사전 계산 JSON)' : 'direct(3단계 API 직접 호출)',
    },
  });
}

const rwisWorker = {
  async fetch(request, env = {}) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Content-Length': '0' } });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(
        { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'GET과 OPTIONS만 지원합니다.' },
        405,
        { Allow: 'GET, HEAD, OPTIONS' }
      );
    }

    if (path === '/api/cctv') return handleCctv(url, env);
    if (path === '/api/rwis') return handleRwis(url, env);
    if (path === '/api/status') return handleStatus(url, env);
    if (path === '/api/stream') return handleStream(url, env);
    if (path === '/' || path === '') return handleIndex(env);

    return jsonResponse(
      { ok: false, error: 'NOT_FOUND', message: `${path} 경로는 없습니다. /api/status, /api/cctv, /api/rwis, /api/stream 을 사용하세요.` },
      404
    );
  },
};

/**
 * bionda/cloudflare/worker.js 의 /rwis 프리픽스 라우터가 호출하는 진입점.
 * (/rwis/api/status 처럼 프리픽스가 제거된 요청이 들어옵니다.)
 */
async function handleRwisFetch(request, env = {}, ctx = null) {
  return rwisWorker.fetch(request, env);
}

// 이 파일만 따로 배포(단독 Worker)할 때를 위해 기본 export 도 그대로 둡니다.

return { handleRwisFetch };
})();

/**
 * 비온다? × 날씨봇 — Cloudflare Workers 무료 티어(24시간 무슬립·일 10만 요청) API 프록시
 * - 비밀 인증키(KMA_SERVICE_KEY 등)는 Cloudflare Workers Secrets(환경변수)에만 보관합니다.
 * - GitHub Pages(poeticecho.github.io) 프론트엔드에서 CORS로 직접 호출해 5분 실시간 갱신을 수행합니다.
 */
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

/**
 * STEP 3: 일 2회(08:00 · 18:00 KST) 정시 채널과 호환되는 경량 라이브 브리핑 JSON
 */
async function buildLiveBriefingPayload(env, { force = false } = {}, ctx = null) {
  const nowMs = Date.now();
  const edition = resolveBriefingEditionMeta(nowMs);
  const roadLine = getRoadLineCode(env);
  const [roadObsRes, roadRiskRes, short12Res, wrnRes] = await Promise.allSettled([
    getRoadKey(env) ? fetchRoadStations(env, roadLine, force, ctx) : Promise.resolve(null),
    getRoadKey(env) ? fetchRoadRisk(env, '012', force) : Promise.resolve(null),
    getServiceKey(env) ? fetchShortTerm12(env, { force, refreshShort: force, refreshUltra: force }) : Promise.resolve(null),
    getServiceKey(env) ? fetchWrnNowList(env, force) : Promise.resolve([])
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
 */
async function buildDataHealthPayload(env, request, { force = false } = {}, ctx = null) {
  const nowMs = Date.now();
  const roadLine = getRoadLineCode(env);
  const edition = resolveBriefingEditionMeta(nowMs);

  const [roadObsRes, roadRiskRes, rwisRes, short12Res, wrnRes] = await Promise.allSettled([
    getRoadKey(env) ? fetchRoadStations(env, roadLine, force, ctx) : Promise.reject(new Error('ROAD_KEY_MISSING')),
    getRoadKey(env) ? fetchRoadRisk(env, '012', force) : Promise.reject(new Error('ROAD_KEY_MISSING')),
    handleRwisFetch(new Request(`https://bionda.pages.dev/api/rwis${force ? '?refresh=1' : ''}`), env, ctx).then(r => r.json()),
    getServiceKey(env) ? fetchShortTerm12(env, { force, refreshShort: force, refreshUltra: force }) : Promise.reject(new Error('SERVICE_KEY_MISSING')),
    getServiceKey(env) ? fetchWrnNowList(env, force) : Promise.reject(new Error('SERVICE_KEY_MISSING'))
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
