/**
 * 엣지 캐시(JSON 직렬화) 왕복에서 RWIS 구간(Map)이 깨지지 않는지 검증
 * ─ 실제 배포(bionda.herego.workers.dev / bionda.pages.dev)에서는 caches.default 가 켜져 있어
 *   캐시에 저장된 값이 JSON 을 거쳐 돌아옵니다. Map 을 그대로 넣으면 {} 가 되어
 *   두 번째 요청부터 'conzones.get is not a function' → errors.rwis 로 떨어졌습니다.
 *   (2026-11-25 라이브에서 /api/rwis/api/status 가 그래서 샘플로 떨어짐)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadWorker() {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'cloudflare', 'worker.js')).href);
  if (mod.__resetWorkerCaches) mod.__resetWorkerCaches();
  return mod.default;
}

function jsonRes(data, status = 200) {
  const text = JSON.stringify(data);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

/** caches.default 를 흉내 냅니다. 저장·조회 모두 JSON 문자열을 거칩니다(실제와 같은 직렬화). */
function installEdgeCache() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(req) {
        const url = typeof req === 'string' ? req : req.url;
        const hit = store.get(url);
        if (!hit) return undefined;
        return new Response(hit, { headers: { 'content-type': 'application/json; charset=utf-8' } });
      },
      async put(req, res) {
        const url = typeof req === 'string' ? req : req.url;
        store.set(url, await res.text());
      }
    }
  };
  return store;
}

const ITS_SAMPLE = {
  response: {
    header: { resultCode: '00', resultMsg: 'SUCCESS' },
    body: {
      items: {
        item: [
          { cctvname: '함양', cctvurl: 'https://cctvsec.ktict.co.kr/1/abc/master.m3u8', cctvformat: 'HLS' },
          { cctvname: '거창', cctvurl: 'https://cctvsec.ktict.co.kr/1/def/master.m3u8', cctvformat: 'HLS' }
        ]
      }
    }
  }
};

const DIRS = ['E', 'S'];
const SUFFIXES = ['160', '170', '180', '190', '200', '210', '220', '230'];

function conzoneResponse(dir) {
  return {
    data: SUFFIXES.map((suffix, i) => ({
      conzoneId: `0120CZ${dir}${suffix}`,
      conzoneNm: `구간${suffix}`,
      conzoneLen: '1000',
      linkIdArrStr: `${dir}L${suffix}-1,${dir}L${suffix}-2`
    }))
  };
}

function riskTableResponse(riskCd, field, tm) {
  const items = [];
  for (const dir of DIRS) {
    for (const suffix of SUFFIXES) {
      for (const n of [1, 2]) {
        items.push({ LINK_ID: `${dir}L${suffix}-${n}`, [field]: n === 2 ? '2' : '0', TM: tm });
      }
    }
  }
  return { header: { resultCode: '00' }, body: { items } };
}

function upstream(url) {
  if (url.includes('openapi.its.go.kr:9443/cctvInfo')) return ITS_SAMPLE;
  if (url.includes('getConZoneByRoadNo.do')) {
    // POST 본문의 방향 코드로 갈라 줍니다.
    return null; // handled below
  }
  if (url.includes('getNrmRoadRiskTimeSet')) return { body: { items: [{ nrmMaxTm: '202611251050' }] } };
  if (url.includes('getNrmRiskRoadTableAll')) {
    const riskCd = new URL(url).searchParams.get('riskCd');
    return riskTableResponse(riskCd, riskCd === 'FR' ? 'FSM' : 'VIR', '202611251050');
  }
  throw new Error(`unexpected upstream: ${url}`);
}

async function mockFetch(input, init) {
  const url = String(input);
  if (url.includes('getConZoneByRoadNo.do')) {
    const body = new URLSearchParams(String((init && init.body) || ''));
    const dir = body.get('cdpntTmnlDirDvCd') || 'E';
    return jsonRes(conzoneResponse(dir));
  }
  return jsonRes(upstream(url));
}

test('엣지 캐시를 두 번 거쳐도 /api/rwis/api/status 의 RWIS 16구간이 살아 있다', async () => {
  const worker = await loadWorker();
  const store = installEdgeCache();
  const before = global.fetch;
  global.fetch = mockFetch;
  try {
    const env = { ITS_API_KEY: 'test-its-key' };
    for (const round of [1, 2, 3]) {
      const res = await worker.fetch(
        new Request(`https://bionda.pages.dev/api/rwis/api/status?refresh=1&round=${round}`),
        env
      );
      assert.equal(res.status, 200, `${round}회차 HTTP`);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.rwis && body.rwis.zones ? body.rwis.zones.length : 0, 16, `${round}회차 RWIS 16구간`);
      assert.deepEqual(body.errors, {}, `${round}회차 errors (${JSON.stringify(body.errors)})`);
      assert.equal(body.cctv.points.length, 62);
    }
    // 캐시에 Map 이 그대로(={} 로) 들어가지 않았는지
    const conzoneKey = [...store.keys()].find((k) => k.includes('rwis:conzones'));
    assert.ok(conzoneKey, 'conzone 캐시 키가 있어야 합니다.');
    const cached = JSON.parse(store.get(conzoneKey));
    assert.ok(Array.isArray(cached), `conzone 캐시는 배열이어야 합니다. (실제: ${JSON.stringify(cached).slice(0, 60)})`);
    assert.equal(cached.length, 16);
  } finally {
    global.fetch = before;
    delete globalThis.caches;
  }
});
