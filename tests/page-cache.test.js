const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function createMockStorage({ failFirst = false } = {}) {
  const map = new Map();
  let failedOnce = false;
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (failFirst && !failedOnce) {
        failedOnce = true;
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    _raw: map
  };
}

test('page-cache: 5분 유효 캐시·정시 경계 무효화·스코프 분리·용량 초과 정리를 검증한다', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'page-cache.js')).href);
  const {
    CACHE_PREFIX,
    DEFAULT_FRESH_MS,
    DEFAULT_DWELL_MS,
    OVERVIEW_REFRESH_MS,
    HOURLY_REFRESH_MS,
    readPageCache,
    writePageCache,
    evaluateCachePolicy,
    currentKstHourKey
  } = mod;

  assert.equal(DEFAULT_FRESH_MS, 5 * 60000);
  assert.equal(DEFAULT_DWELL_MS, 3 * 60000);
  assert.equal(OVERVIEW_REFRESH_MS, 5 * 60000);
  assert.equal(HOURLY_REFRESH_MS, 10 * 60000);

  const storage = createMockStorage({ failFirst: true });
  storage._raw.set(`${CACHE_PREFIX}stale-other`, JSON.stringify({ old: true }));

  const t0 = Date.parse('2026-11-19T07:50:00+09:00');
  assert.equal(currentKstHourKey(t0), '2026-11-19T07');

  // QuotaExceededError 시 기존 CACHE_PREFIX 키 정리 후 정상 저장
  const saved = writePageCache(`${CACHE_PREFIX}overview:v1`, {
    scope: 'bionda|8regions',
    data: { temp: 3.1 },
    nowMs: t0,
    storage
  });
  assert.equal(saved, true);
  assert.equal(storage.getItem(`${CACHE_PREFIX}stale-other`), null);

  // 1) 스코프 불일치 시 무효화
  const wrongScope = readPageCache(`${CACHE_PREFIX}overview:v1`, {
    expectedScope: 'bionda|9regions',
    nowMs: t0 + 30000,
    storage
  });
  assert.equal(wrongScope, null);

  // 2) 1분 후 재방문(같은 07시) → 0ms 즉시 렌더 + 중복 API 생략 + 3분(180s) 머무름 SWR 예약
  const hit1m = readPageCache(`${CACHE_PREFIX}overview:v1`, {
    expectedScope: 'bionda|8regions',
    nowMs: t0 + 60000,
    storage
  });
  assert.ok(hit1m);
  assert.equal(hit1m.sameHour, true);
  const p1m = evaluateCachePolicy({ cacheHit: hit1m });
  assert.deepEqual(p1m, {
    hasUsableCache: true,
    cacheIsFresh: true,
    shouldFetchNow: false,
    backgroundDwellDelayMs: 3 * 60000
  });

  // 3) 4분 20초 후 재방문 → 즉시 렌더 + 남은 유효기간(40초)에 SWR
  const hit4m20s = readPageCache(`${CACHE_PREFIX}overview:v1`, {
    expectedScope: 'bionda|8regions',
    nowMs: t0 + 260000,
    storage
  });
  const p4m20s = evaluateCachePolicy({ cacheHit: hit4m20s });
  assert.equal(p4m20s.hasUsableCache, true);
  assert.equal(p4m20s.cacheIsFresh, true);
  assert.equal(p4m20s.shouldFetchNow, false);
  assert.equal(p4m20s.backgroundDwellDelayMs, 40000);

  // 4) 정시(08:00) 경과(07:50 저장 → 07:52 아닌 08:01) → 11분은 물론 2분 만에도 정시 변경 시 즉시 SWR
  const tBeforeHour = Date.parse('2026-11-19T07:59:00+09:00');
  writePageCache(`${CACHE_PREFIX}hourly:v1`, {
    scope: 'same',
    data: { ok: true, regions: [] },
    nowMs: tBeforeHour,
    storage
  });
  const hitAfterHour = readPageCache(`${CACHE_PREFIX}hourly:v1`, {
    expectedScope: 'same',
    nowMs: Date.parse('2026-11-19T08:01:00+09:00'),
    storage
  });
  assert.ok(hitAfterHour);
  assert.equal(hitAfterHour.sameHour, false);
  const pRollover = evaluateCachePolicy({ cacheHit: hitAfterHour });
  assert.deepEqual(pRollover, {
    hasUsableCache: true,
    cacheIsFresh: false,
    shouldFetchNow: true,
    backgroundDwellDelayMs: null
  });

  // 5) 단기예보 초단기(36분) 도래(forceImmediate: true) 시 즉시 SWR
  const hitUltra = readPageCache(`${CACHE_PREFIX}overview:v1`, {
    expectedScope: 'bionda|8regions',
    nowMs: t0 + 60000,
    storage
  });
  const pUltra = evaluateCachePolicy({ cacheHit: hitUltra, forceImmediate: true });
  assert.equal(pUltra.hasUsableCache, true);
  assert.equal(pUltra.shouldFetchNow, true);

  // 6) 20분 초과 시 완전 폐기
  const expired = readPageCache(`${CACHE_PREFIX}overview:v1`, {
    expectedScope: 'bionda|8regions',
    nowMs: t0 + 21 * 60000,
    storage
  });
  assert.equal(expired, null);
  const pEmpty = evaluateCachePolicy({ cacheHit: null });
  assert.deepEqual(pEmpty, {
    hasUsableCache: false,
    cacheIsFresh: false,
    shouldFetchNow: true,
    backgroundDwellDelayMs: null
  });
});

test('registerManualRefreshClick: 5분 내 2회 이상 클릭 시 강제 즉시갱신(isHardForce)으로 격상되고 5분 경과 시 초기화된다', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'page-cache.js')).href);
  const {
    RAPID_REFRESH_WINDOW_MS,
    registerManualRefreshClick,
    resetManualRefreshClicks
  } = mod;

  assert.equal(RAPID_REFRESH_WINDOW_MS, 5 * 60000);
  const storage = createMockStorage();
  resetManualRefreshClicks('rwis', storage);
  resetManualRefreshClicks('hourly', storage);

  const t0 = Date.parse('2026-11-26T11:20:00+09:00');

  // 1회차 클릭 -> 일반 스마트 새로고침
  const c1 = registerManualRefreshClick('rwis', { nowMs: t0, storage });
  assert.equal(c1.count, 1);
  assert.equal(c1.isHardForce, false);

  // 다른 페이지 스코프(hourly)는 독립적으로 1회차로 시작
  const h1 = registerManualRefreshClick('hourly', { nowMs: t0 + 10000, storage });
  assert.equal(h1.count, 1);
  assert.equal(h1.isHardForce, false);

  // 2분 뒤(5분 이내) 2회차 클릭 -> 즉시 강제 원천 갱신(isHardForce = true)
  const c2 = registerManualRefreshClick('rwis', { nowMs: t0 + 2 * 60000, storage });
  assert.equal(c2.count, 2);
  assert.equal(c2.isHardForce, true);

  // 4분 뒤(5분 이내) 3회차 클릭 -> 계속 강제 갱신 유지
  const c3 = registerManualRefreshClick('rwis', { nowMs: t0 + 4 * 60000, storage });
  assert.equal(c3.count, 3);
  assert.equal(c3.isHardForce, true);

  // 마지막 클릭(t0+4m)으로부터 5분 1초 경과(t0+9m01s) -> 이전 이력 만료되어 다시 1회차 일반 새로고침으로 복귀
  const cAfterWindow = registerManualRefreshClick('rwis', { nowMs: t0 + 9 * 60000 + 1000, storage });
  assert.equal(cAfterWindow.count, 1);
  assert.equal(cAfterWindow.isHardForce, false);
});

test('writeSharedRoadObs & refreshObservationWithStations: 양전교 등 도로관측(tm1) 단조 증가 SSOT 동기화로 페이지 간 수치 역전을 원천 차단한다', async () => {
  const cacheMod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'page-cache.js')).href);
  const obsMod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'observations.js')).href);
  const { extractRoadObsTm, readSharedRoadObs, writeSharedRoadObs } = cacheMod;
  const { refreshObservationWithStations } = obsMod;

  const storage = createMockStorage();
  const nowMs = Date.parse('2026-11-26T11:24:00+09:00');

  const stns1122 = [
    { stnId: '14209', name: '양전교(도)', tm: '202611261122', time: '2026-11-26T11:22:00+09:00', roadTemp: 7.9, temp: 6.6, humidity: 77, surfaceCode: 1, surfaceState: '건조' }
  ];
  const stnsStale1115 = [
    { stnId: '14209', name: '양전교(도)', tm: '202611261115', time: '2026-11-26T11:15:00+09:00', roadTemp: 7.0, temp: 5.8, humidity: 78, surfaceCode: 1, surfaceState: '건조' }
  ];
  const stnsNewer1124 = [
    { stnId: '14209', name: '양전교(도)', tm: '202611261124', time: '2026-11-26T11:24:00+09:00', roadTemp: 8.1, temp: 6.8, humidity: 76, surfaceCode: 1, surfaceState: '건조' }
  ];

  assert.equal(extractRoadObsTm(stns1122), '202611261122');

  // 1) 상황판(index.html)이 11:22 최신 관측(양전교 7.9°)을 기록
  const r1 = writeSharedRoadObs({ line: '14', stations: stns1122, nowMs, storage });
  assert.equal(r1.tm1, '202611261122');
  assert.equal(r1.stations[0].roadTemp, 7.9);

  // 2) 타 탭이 지연된 11:15 캐시본(양전교 7.0°)을 덮어쓰려 해도 단조 증가 규칙으로 11:22(7.9°) 보존!
  const rStale = writeSharedRoadObs({ line: '14', stations: stnsStale1115, nowMs: nowMs + 5000, storage });
  assert.equal(rStale.tm1, '202611261122');
  assert.equal(rStale.stations[0].roadTemp, 7.9);
  assert.equal(readSharedRoadObs({ line: '14', nowMs: nowMs + 5000, storage }).stations[0].roadTemp, 7.9);

  // 3) 11:24 더 최신 관측(8.1°) 수신 시 정상 전진 업데이트
  const rNewer = writeSharedRoadObs({ line: '14', stations: stnsNewer1124, nowMs: nowMs + 10000, storage });
  assert.equal(rNewer.tm1, '202611261124');
  assert.equal(rNewer.stations[0].roadTemp, 8.1);

  // 4) index.html 관심지역 카드·미니맵 관측 객체도 최신 관측소 값으로 동기화되며 과거 값으로는 역전되지 않음
  const placeObs = {
    stnId: '14209',
    name: '양전교(도)',
    roadStationName: '양전교(도)',
    time: '2026-11-26T11:15:00+09:00',
    roadTemp: 7.0,
    temp: 5.8,
    humidity: 78,
    surfaceCode: 1,
    surfaceState: '건조'
  };
  const upgraded = refreshObservationWithStations(placeObs, stns1122);
  assert.equal(upgraded.roadTemp, 7.9);
  assert.equal(upgraded.temp, 6.6);
  assert.equal(upgraded.time, '2026-11-26T11:22:00+09:00');

  const notDowngraded = refreshObservationWithStations(upgraded, stnsStale1115);
  assert.equal(notDowngraded.roadTemp, 7.9);
  assert.equal(notDowngraded.temp, 6.6);
});
