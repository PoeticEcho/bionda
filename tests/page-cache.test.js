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
