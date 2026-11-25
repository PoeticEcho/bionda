/**
 * /rwis 프리픽스 라우팅 검증
 * ─ bionda/cloudflare/worker.js 가 /rwis, /rwis/api/* 를 cloudflare/rwis-worker.js 로
 *   프리픽스를 떼어 위임하는지, 기존 bionda 의 /api/* 가 전혀 영향받지 않는지 확인합니다.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadWorker() {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'cloudflare', 'worker.js')).href);
  if (mod.__resetWorkerCaches) mod.__resetWorkerCaches();
  if (globalThis.__GDC_MEMO) globalThis.__GDC_MEMO.clear();
  return mod.default;
}

function jsonRes(data, status = 200) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => data,
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
    headers: new Map(),
  };
}

const ITS_SAMPLE = {
  response: {
    header: { resultCode: '00', resultMsg: 'SUCCESS' },
    body: {
      items: {
        item: [
          { cctvname: '함양', cctvurl: 'https://cctvsec.ktict.co.kr/1/abc/master.m3u8', cctvformat: 'HLS', coordx: '127.748835', coordy: '35.533199' },
          { cctvname: '거창', cctvurl: 'https://cctvsec.ktict.co.kr/1/def/master.m3u8', cctvformat: 'HLS', coordx: '127.93523', coordy: '35.679166' },
          { cctvname: '고령', cctvurl: 'https://cctvsec.ktict.co.kr/1/ghi/master.m3u8', cctvformat: 'HLS', coordx: '128.244782', coordy: '35.700934' }
        ]
      }
    }
  }
};

const RWIS_SOURCE_SAMPLE = {
  generatedAt: '2026-11-25T01:20:00.000Z',
  tm: '202611250920',
  source: 'RWIS_SOURCE_URL(사전 계산)',
  zones: Array.from({ length: 16 }, (_, i) => ({
    id: `0120CZ${i % 2 === 0 ? 'E' : 'S'}${160 + Math.floor(i / 2) * 10}`,
    name: `구간${i}`,
    dir: i % 2 === 0 ? 'E' : 'S',
    fsm: { level: i === 3 ? 2 : 0 },
    vir: { level: 0 }
  })),
  summary: { fsmMax: 2, virMax: 0 }
};

function withFetch(mock, fn) {
  const before = global.fetch;
  global.fetch = mock;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = before;
    });
}

test('/rwis 는 rwis-worker 로 위임되어 광주대구선 안내(JSON)를 돌려준다', async () => {
  const worker = await loadWorker();
  const res = await worker.fetch(new Request('https://bionda.herego.workers.dev/rwis'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.service, /광주대구선/);
  assert.equal(body.version, '2.3.0');
  assert.equal(body.master.points, 62);
  assert.equal(body.master.cameras, 123);
  assert.equal(body.master.rwisZones, 16);
  // 기존 bionda 의 안내(JSON)가 아니라 rwis-worker 의 응답이어야 합니다.
  assert.equal(body.status, undefined);
});

test('/rwis/api/cctv 는 프리픽스를 떼고 ITS 호출 → 123대 마스터 매칭을 수행한다', async () => {
  const worker = await loadWorker();
  const called = [];
  await withFetch(
    async (input, init) => {
      const u = String(input);
      called.push({ url: u, method: (init && init.method) || 'GET' });
      if (u.includes('openapi.its.go.kr:9443/cctvInfo')) return jsonRes(ITS_SAMPLE);
      throw new Error(`unexpected upstream: ${u}`);
    },
    async () => {
      const res = await worker.fetch(
        new Request('https://bionda.herego.workers.dev/rwis/api/cctv', { headers: { Origin: 'https://poeticecho.github.io' } }),
        { ITS_API_KEY: 'test-its-key' }
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const body = await res.json();
      assert.equal(body.kind, 'cctv');
      assert.equal(body.count, 3);
      assert.equal(body.points.length, 62);
      assert.ok(body.stats.matchedCctvItems >= 3, '함양·거창·고령이 마스터에 매칭되어야 합니다.');
    }
  );
  assert.equal(called.length, 1, '업스트림 호출은 한 번이어야 합니다.');
  assert.match(called[0].url, /openapi\.its\.go\.kr:9443\/cctvInfo/);
  assert.match(called[0].url, /apiKey=test-its-key/);
});

test('/rwis/api/rwis 는 RWIS_SOURCE_URL 사전 계산 JSON 을 그대로 중계한다', async () => {
  const worker = await loadWorker();
  let hit = '';
  await withFetch(
    async (input) => {
      hit = String(input);
      return jsonRes(RWIS_SOURCE_SAMPLE);
    },
    async () => {
      const res = await worker.fetch(new Request('https://bionda.herego.workers.dev/rwis/api/rwis'), {
        RWIS_SOURCE_URL: 'https://example.com/rwis_latest.json'
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.kind, 'rwis');
      assert.equal(body.via, 'source-url');
      assert.equal(body.zones.length, 16);
      assert.equal(body.tm, '202611250920');
    }
  );
  assert.equal(hit, 'https://example.com/rwis_latest.json');
});

test('/rwis/api/status 는 CCTV·RWIS 를 한 번에 돌려주고 실패한 쪽만 errors 에 담는다', async () => {
  const worker = await loadWorker();
  await withFetch(
    async (input) => {
      const u = String(input);
      if (u.includes('openapi.its.go.kr:9443/cctvInfo')) return jsonRes(ITS_SAMPLE);
      if (u.includes('rwis_latest.json')) return jsonRes(RWIS_SOURCE_SAMPLE);
      throw new Error(`unexpected upstream: ${u}`);
    },
    async () => {
      const res = await worker.fetch(new Request('https://bionda.herego.workers.dev/rwis/api/status?refresh=1'), {
        ITS_API_KEY: 'test-its-key',
        RWIS_SOURCE_URL: 'https://example.com/rwis_latest.json'
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.version, '2.3.0');
      assert.equal(body.cctv.kind, 'cctv');
      assert.equal(body.rwis.kind, 'rwis');
      assert.equal(body.cctv.points.length, 62);
      assert.equal(body.master.zones.length, 8);
      assert.deepEqual(body.errors, {});
    }
  );
});

test('/rwis/api/stream 은 쿼리(cctvId)까지 그대로 전달한다', async () => {
  const worker = await loadWorker();
  const res = await worker.fetch(new Request('https://bionda.herego.workers.dev/rwis/api/stream?cctvId=bad-id'), {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'INVALID_CCTV_ID');
  assert.match(body.message, /cctv/);
});

test('OPTIONS /rwis/api/status 는 rwis-worker 가 204 + CORS 로 응답한다', async () => {
  const worker = await loadWorker();
  const res = await worker.fetch(
    new Request('https://bionda.herego.workers.dev/rwis/api/status', { method: 'OPTIONS' }),
    {}
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('기존 bionda /api/* 는 /rwis 와 겹치지 않는다 (health·cctv·404·prefix 경계)', async () => {
  const worker = await loadWorker();

  // 1. /api/health 는 그대로 bionda 자신
  const health = await worker.fetch(new Request('https://bionda.herego.workers.dev/api/health'), {});
  assert.equal(health.status, 200);
  const hb = await health.json();
  assert.equal(hb.runtime, 'cloudflare-workers');
  assert.equal(hb.status, 'ok');

  // 2. bionda 자신의 /api/cctv 는 ITS_API_KEY 가 없으면 500 ITS_API_KEY_MISSING
  //    (rwis-worker 의 /rwis/api/cctv 와 같은 경로가 아니라 다른 핸들러임을 증명)
  const ownCctv = await worker.fetch(new Request('https://bionda.herego.workers.dev/api/cctv'), {});
  assert.equal(ownCctv.status, 500);
  const ob = await ownCctv.json();
  assert.equal(ob.error, 'ITS_API_KEY_MISSING');

  // 3. /rwis 와 무관한 경로는 기존 404
  const notFound = await worker.fetch(new Request('https://bionda.herego.workers.dev/rwisfoo/api/status'), {});
  assert.equal(notFound.status, 404);
  const nf = await notFound.json();
  assert.equal(nf.error, 'API를 찾지 못했습니다.');

  // 4. /rwis 의 하위가 아닌 /rwisx 도 위임되지 않는다
  const rwisx = await worker.fetch(new Request('https://bionda.herego.workers.dev/rwis-other'), {});
  assert.equal(rwisx.status, 404);
});

test('/rwis 라우팅은 bionda 자체 rate limit·API 라우팅보다 먼저 처리된다', async () => {
  const worker = await loadWorker();
  // 같은 IP 로 여러 번 호출해도 /rwis 는 bionda 의 60초 카운터를 소모하지 않습니다.
  // (bionda 쪽 /api 호출이 429 로 막히지 않는지 함께 확인)
  const ip = { 'cf-connecting-ip': '203.0.113.7' };
  for (let i = 0; i < 5; i += 1) {
    const r = await worker.fetch(new Request('https://bionda.herego.workers.dev/rwis', { headers: ip }), {});
    assert.equal(r.status, 200);
  }
  const health = await worker.fetch(new Request('https://bionda.herego.workers.dev/api/health', { headers: ip }), {});
  assert.equal(health.status, 200);
});
