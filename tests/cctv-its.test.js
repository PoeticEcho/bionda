const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CCTV_SITES,
  normalizeCctvName,
  findCctvArray,
  matchCctvLabel,
  buildCctvSites,
  buildItsCctvUrl,
  buildCctvPayload
} = require('../lib/cctv-its');

test('lib/cctv-its는 다양한 ITS JSON 구조(body.items.item, response.data, 평면 배열)를 해석하고 19개 지점을 매칭한다', () => {
  assert.equal(CCTV_SITES.length, 19);
  assert.equal(normalizeCctvName('논공교2 (상행)'), '논공교2');

  const sample1 = {
    response: {
      body: {
        items: {
          item: [
            { cctvname: '논공교2(상행)', cctvurl: 'https://live.example.com/a/playlist.m3u8', cctvformat: 'HLS', coordx: '128.42', coordy: '35.76' },
            { cctvname: '논공교2(하행)', cctvurl: 'https://live.example.com/b/playlist.m3u8', cctvformat: 'HLS', coordx: '128.42', coordy: '35.76' },
            { cctvname: '번암교', cctvurl: 'https://live.example.com/c/playlist.m3u8', cctvformat: 'HLS', coordx: '127.54', coordy: '35.47' },
            { cctvname: '가조터널(외부대구)', cctvurl: 'https://live.example.com/d/playlist.m3u8', cctvformat: 'HLS', coordx: '128.05', coordy: '35.70' }
          ]
        }
      }
    }
  };

  const arr = findCctvArray(sample1);
  assert.equal(arr.length, 4);

  const normalized = arr.map((x) => ({
    name: x.cctvname,
    url: x.cctvurl,
    format: x.cctvformat,
    x: Number(x.coordx),
    y: Number(x.coordy)
  }));

  const mExact = matchCctvLabel('논공교2', normalized);
  assert.equal(mExact.mode, 'exact');
  assert.equal(mExact.items.length, 2);

  const mPartial = matchCctvLabel('가조터널', normalized);
  assert.equal(mPartial.mode, 'exact');
  assert.equal(mPartial.items.length, 1);

  const built = buildCctvSites(normalized);
  assert.equal(built.sites.length, 19);
  assert.equal(built.stats.sites, 19);
  assert.ok(built.stats.matchedLabels >= 4);
  assert.ok(built.stats.unmatchedLabels.includes('우명교'));

  const { normalizeCctvItem } = require('../lib/cctv-its');
  const upgraded = normalizeCctvItem({
    cctvname: '[광주대구선] 논공교2',
    cctvurl: 'http://cctvsec.ktict.co.kr/2812/sampleToken',
    cctvformat: 'HLS',
    coordx: '128.427',
    coordy: '35.7683'
  });
  assert.equal(upgraded.url, 'https://cctvsec.ktict.co.kr/2812/sampleToken');

  const itsUrl = buildItsCctvUrl('TEST_KEY');
  assert.match(itsUrl, /^https:\/\/openapi\.its\.go\.kr:9443\/cctvInfo\?/);
  assert.match(itsUrl, /type=ex/);
  assert.match(itsUrl, /cctvType=1/);
  assert.match(itsUrl, /getType=json/);
});

test('buildCctvPayload는 키 누락 시 ITS_API_KEY_MISSING, ITS 오류 헤더 시 ITS_API_ERROR를 반환한다', async () => {
  await assert.rejects(
    () => buildCctvPayload({}, async () => { throw new Error('should not fetch'); }),
    (err) => err && err.code === 'ITS_API_KEY_MISSING'
  );

  const fakeErrorFetch = async () => new Response(JSON.stringify({
    response: { header: { resultCode: '99', resultMsg: 'INVALID_KEY' }, body: { items: [] } }
  }), { status: 200 });

  await assert.rejects(
    () => buildCctvPayload({ ITS_API_KEY: 'bad-key' }, fakeErrorFetch),
    (err) => err && err.code === 'ITS_API_ERROR' && err.detail.resultCode === '99'
  );
});

test('Cloudflare Worker /api/cctv는 키 미설정 500, MISS→HIT 15분 캐시, ?refresh=1 갱신, CCTV_SOURCE_URL 및 health cctvConfigured를 정확히 처리한다', async () => {
  const { default: worker, __resetWorkerCaches } = await import('../cloudflare/worker.js');
  __resetWorkerCaches();

  // 1. /api/health without key
  const h0 = await worker.fetch(new Request('https://bionda.pages.dev/api/health'), {});
  const h0Json = await h0.json();
  assert.equal(h0Json.cctvConfigured, false);

  // 2. /api/cctv without key -> 500 ITS_API_KEY_MISSING
  const missingRes = await worker.fetch(new Request('https://bionda.pages.dev/api/cctv'), {});
  assert.equal(missingRes.status, 500);
  const missingJson = await missingRes.json();
  assert.equal(missingJson.ok, false);
  assert.equal(missingJson.error, 'ITS_API_KEY_MISSING');
  assert.equal(missingRes.headers.get('X-Cache'), 'BYPASS');

  // 3. Mock global fetch for CCTV_SOURCE_URL & verify MISS -> HIT -> REFRESH
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    assert.equal(String(url), 'https://example.internal/its.json');
    return new Response(JSON.stringify({
      response: {
        data: [
          { cctvname: '번암교', cctvurl: 'https://live14.exmobile.hscdn.com/livehttp/test/playlist.m3u8', cctvformat: 'HLS', coordx: 127.54, coordy: 35.47 },
          { cctvname: '논공교2(상행)', cctvurl: 'https://live14.exmobile.hscdn.com/livehttp/n1/playlist.m3u8', cctvformat: 'HLS', coordx: 128.42, coordy: 35.76 },
          { cctvname: '논공교2(하행)', cctvurl: 'https://live14.exmobile.hscdn.com/livehttp/n2/playlist.m3u8', cctvformat: 'HLS', coordx: 128.42, coordy: 35.76 }
        ]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const env = { CCTV_SOURCE_URL: 'https://example.internal/its.json' };

    const h1 = await worker.fetch(new Request('https://bionda.pages.dev/api/health'), env);
    assert.equal((await h1.json()).cctvConfigured, true);

    const r1 = await worker.fetch(new Request('https://bionda.pages.dev/api/cctv'), env);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('X-Cache'), 'MISS');
    const j1 = await r1.json();
    assert.equal(j1.ok, true);
    assert.equal(j1.cache, 'MISS');
    assert.equal(j1.count, 3);
    assert.equal(j1.sites.length, 19);
    assert.equal(fetchCalls, 1);

    const r2 = await worker.fetch(new Request('https://bionda.pages.dev/api/cctv'), env);
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('X-Cache'), 'HIT');
    const j2 = await r2.json();
    assert.equal(j2.cache, 'HIT');
    assert.equal(fetchCalls, 1);

    const r3 = await worker.fetch(new Request('https://bionda.pages.dev/api/cctv?refresh=1'), env);
    assert.equal(r3.status, 200);
    assert.equal(r3.headers.get('X-Cache'), 'REFRESH');
    const j3 = await r3.json();
    assert.equal(j3.cache, 'REFRESH');
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = origFetch;
    __resetWorkerCaches();
  }
});

test('configured ITS source recovers from a failed custom mirror', async () => {
  let calls = 0;
  const payload = await buildCctvPayload({ CCTV_SOURCE_URL: 'https://example.org/mirror', ITS_API_KEY: 'test' }, async input => {
    calls++;
    if (new URL(input).hostname === 'example.org') return new Response(null, { status: 502 });
    assert.equal(new URL(input).hostname, 'openapi.its.go.kr');
    return Response.json({ response: { data: [{ cctvname: '야로대교1', cctvurl: 'https://example.org/live.m3u8' }] } });
  });
  assert.equal(calls, 2);
  assert.equal(payload.count, 1);
  assert.equal(payload.sites.find(s => s.id === 'hapcheon-seobuk').nearest.items.length, 1);
});

test('Pages serves the recent directory during a 502 and rejects expired or rate-limited fallback', async t => {
  const { onRequest } = await import('../functions/api/[[path]].js');
  const stored = new Map();
  const pending = [];
  t.mock.method(Date, 'now', () => now);
  let now = Date.parse('2026-11-20T18:00:00Z');
  const live = { ok: true, cctvs: [{ name: '야로대교1', url: 'https://example.org/live.m3u8' }],
    fetchedAt: new Date(now).toISOString() };
  let code = 200;
  const original = globalThis.caches;
  globalThis.caches = { default: {
    put: (key, res) => stored.set(key.url, res),
    match: async key => stored.get(key.url)?.clone(),
  } };
  t.after(() => { if (original) globalThis.caches = original; else delete globalThis.caches; });
  const ctx = {
    request: new Request('https://bionda.pages.dev/api/cctv'),
    env: { API_WORKER: { fetch: async () => Response.json(code === 200 ? live : {}, { status: code }) } },
    waitUntil: p => pending.push(p),
  };
  assert.equal((await onRequest(ctx)).status, 200);
  await Promise.all(pending);
  code = 502;
  ctx.request = new Request('https://bionda.pages.dev/api/cctv?refresh=1');
  const result = await onRequest(ctx);
  assert.equal(result.headers.get('X-Cache'), 'STALE');
  assert.equal((await result.json()).fetchedAt, live.fetchedAt);
  code = 429;
  assert.equal((await onRequest(ctx)).status, 429);
  code = 502;
  now += 30 * 60 * 1000;
  assert.equal((await onRequest(ctx)).status, 502);
});

test('Pages retries a failed binding using its configured CCTV source on the first visit', async t => {
  const { onRequest } = await import('../functions/api/[[path]].js');
  const { __resetWorkerCaches } = await import('../cloudflare/worker.js');
  __resetWorkerCaches();
  t.after(__resetWorkerCaches);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://example.org/its.json');
    return Response.json([{ cctvname: '야로대교1', cctvurl: 'https://example.org/live.m3u8' }]);
  });
  const res = await onRequest({
    request: new Request('https://bionda.pages.dev/api/cctv'),
    env: { CCTV_SOURCE_URL: 'https://example.org/its.json',
      API_WORKER: { fetch: async () => new Response(null, { status: 502 }) } },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cctvs[0].name, '야로대교1');
});
