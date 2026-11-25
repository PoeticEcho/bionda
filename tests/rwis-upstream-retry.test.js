/**
 * ITS·RWIS 업스트림이 한 번 중단(AbortError)되어도 재시도로 살아나는지 검증
 * ─ 2026-11-25 라이브에서 /api/rwis/api/status 가 errors.cctv "The operation was aborted"(code 20)
 *   로 떨어진 적이 있습니다. fetchJsonOnce 가 DOMException 의 숫자 code(20)를 먼저 던져
 *   재시도 경로(UPSTREAM_TIMEOUT)를 타지 못하던 문제를 고친 뒤의 동작입니다.
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

const ITS_SAMPLE = {
  response: {
    header: { resultCode: '00', resultMsg: 'SUCCESS' },
    body: { items: { item: [{ cctvname: '함양', cctvurl: 'https://cctvsec.ktict.co.kr/1/abc/master.m3u8', cctvformat: 'HLS' }] } }
  }
};

test('ITS 목록이 첫 시도에서 abort 되어도 한 번 재시도해 CCTV 목록을 돌려준다', async () => {
  const worker = await loadWorker();
  const before = global.fetch;
  let itsCalls = 0;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('openapi.its.go.kr:9443/cctvInfo')) {
      itsCalls += 1;
      if (itsCalls === 1) {
        const err = new DOMException('The operation was aborted', 'AbortError');
        throw err;
      }
      return new Response(JSON.stringify(ITS_SAMPLE), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected upstream: ${url}`);
  };
  try {
    const res = await worker.fetch(new Request('https://bionda.pages.dev/api/rwis/api/cctv'), { ITS_API_KEY: 'test-its-key' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, 'cctv');
    assert.ok(body.count >= 1);
    assert.equal(itsCalls, 2, 'ITS 를 두 번 호출해야 합니다(1회 중단 + 1회 성공).');
  } finally {
    global.fetch = before;
  }
});
