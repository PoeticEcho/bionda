const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const zlib = require('node:zlib');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function makeTestZip(entries) {
  const locals = [];
  const cds = [];
  let offset = 0;
  for (const { name, content, deflate = false } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const comp = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);

    locals.push(lfh, nameBuf, comp);
    cds.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

function makeEucKrRoadSample() {
  // Valid ASCII + Korean station row? Test pure ASCII + Hangul UTF/EUC-KR roundtrip check separately
  return [
    '#START7777',
    ' 202611182200, 14207, Namsang(Road), Route12, Base, 35.6366, 127.9066, 220, 1, 7.4, 48448, 77.0, 0.0, 0.0, 6.6, 216.1, 1.7, 222.0, 2.3, 1014, -999, -999, -999, -999',
    '#7777END'
  ].join('\n');
}

test('Cloudflare Worker는 CORS·OPTIONS·health·도로관측(중복 Ncst 생략)·예보·특보·레이더·429를 정확히 처리한다', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'cloudflare', 'worker.js')).href);
  const worker = mod.default;
  mod.__resetWorkerCaches();

  const env = {
    KMA_SERVICE_KEY: 'worker-secret-test-key',
    ROAD_LINE_CODE: '14'
  };

  // 1. OPTIONS preflight + /api/health
  const optRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/health', {
    method: 'OPTIONS',
    headers: { Origin: 'https://poeticecho.github.io' }
  }), env);
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get('access-control-allow-origin'), '*');

  const healthRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/health'), env);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.runtime, 'cloudflare-workers');
  assert.equal(health.forecastConfigured, true);

  // 2. Mock upstream KMA & Open-Meteo
  const beforeFetch = global.fetch;
  const hitUrls = [];
  const pad = n => String(n).padStart(2, '0');
  const nowKst = new Date(Date.now() + 9 * 3600000);
  nowKst.setUTCMinutes(0, 0, 0);
  const mkItems = (resName) => {
    if (resName === 'getUltraSrtNcst') {
      return [{ category: 'PTY', obsrValue: '0' }, { category: 'RN1', obsrValue: '0' }, { category: 'T1H', obsrValue: '6.6' }];
    }
    const items = [];
    // 현재 정시(i=0)부터 +14시간(+6시간 초단기)까지 생성해 매시 :00~:29 구간 실행 시에도 12시간 창을 안정적으로 충족
    for (let i = 0; i <= (resName === 'getUltraSrtFcst' ? 6 : 14); i++) {
      const d = new Date(nowKst.getTime() + i * 3600000);
      const fcstDate = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      const fcstTime = `${pad(d.getUTCHours())}00`;
      items.push({ fcstDate, fcstTime, category: 'PTY', fcstValue: i === 2 ? '1' : '0' });
      items.push({ fcstDate, fcstTime, category: 'POP', fcstValue: i === 2 ? '70' : '10' });
      items.push({ fcstDate, fcstTime, category: resName === 'getUltraSrtFcst' ? 'RN1' : 'PCP', fcstValue: i === 2 ? '1mm' : '강수없음' });
      items.push({ fcstDate, fcstTime, category: resName === 'getUltraSrtFcst' ? 'T1H' : 'TMP', fcstValue: '5.5' });
    }
    return items;
  };

  let roadObsAttempt = 0;
  global.fetch = async (input) => {
    const u = String(input);
    hitUrls.push(u);
    if (u.includes('road_stn_obs.php')) {
      roadObsAttempt++;
      if (roadObsAttempt === 1) throw new Error('Simulated KMA minute timeout');
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(makeEucKrRoadSample(), 'utf8') };
    }
    if (u.includes('wrn_now_data.php')) {
      // Raw EUC-KR bytes for "한파" + "주의" + "발표": keep ASCII regression test + valid EUC-KR byte sequence check
      // EUC-KR bytes for "거창군남부": B0 C5 C3 A2 B1 BA B3 B2 BA CE
      const linePrefix = Buffer.from('L1083300, ', 'ascii');
      const geochang = Buffer.from([0xB0, 0xC5, 0xC3, 0xA2, 0xB1, 0xBA]); // 거창군
      const midComma = Buffer.from(', L1083320, ', 'ascii');
      const geochangSouth = Buffer.from([0xB0, 0xC5, 0xC3, 0xA2, 0xB1, 0xBA, 0xB3, 0xB2, 0xBA, 0xCE]); // 거창군남부
      const dates = Buffer.from(', 202611181100, 202611182100, ', 'ascii');
      const hanpa = Buffer.from([0xC7, 0xD1, 0xC6, 0xC4]); // 한파
      const midComma2 = Buffer.from(', ', 'ascii');
      const juuibo = Buffer.from([0xC1, 0xD6, 0xC0, 0xC7]); // 주의
      const balpyo = Buffer.from([0xB9, 0xDF, 0xC7, 0xA5]); // 발표
      const endLine = Buffer.from(', 20th AM,=\n', 'ascii');
      const rawBuf = Buffer.concat([linePrefix, geochang, midComma, geochangSouth, dates, hanpa, midComma2, juuibo, midComma2, balpyo, endLine]);
      return { ok: true, status: 200, arrayBuffer: async () => rawBuf };
    }
    if (u.includes('VilageFcstInfoService_2.0/')) {
      const parsedU = new URL(u);
      const resName = parsedU.pathname.split('/').at(-1);
      const nx = parsedU.searchParams.get('nx');
      const items = mkItems(resName);
      if (nx === '74') {
        for (const it of items) {
          if (it.category === 'TMP' || it.category === 'T1H') it.fcstValue = '-2.0';
          if (it.category === 'PTY' && it.fcstValue === '1') it.fcstValue = '3';
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'OK' }, body: { items: { item: items } } } })
      };
    }
    if (u.includes('nph-rdr_cmp1_img')) {
      const pngBytes = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
      return { ok: true, status: 200, arrayBuffer: async () => pngBytes.buffer };
    }
    if (u.includes('ensemble-api.open-meteo.com')) {
      return { ok: false, status: 429, json: async () => ({ error: true }) };
    }
    if (u.includes('road_file_down.php')) {
      assert.ok(u.includes('roadNum=012'));
      const frgCsv = [
        'LINK_ID,S_NUM,F_LON,F_LAT,T_LON,T_LAT,B_ICE,FLAG,X_GRID,Y_GRID',
        '1570030500,1,127.7490,35.5325,127.7500,35.5330,2,1,350,300',
        '1570030600,1,128.4010,35.7650,128.4020,35.7656,3,0,390,305'
      ].join('\n');
      const fogCsv = [
        'LINK_ID,S_NUM,F_LON,F_LAT,T_LON,T_LAT,FOG,FLAG,X_GRID,Y_GRID',
        '1570030500,1,127.7490,35.5325,127.7500,35.5330,1,0,350,300',
        '1570030600,1,128.4010,35.7650,128.4020,35.7656,0,0,390,305'
      ].join('\n');
      const zipBuf = makeTestZip([
        { name: 'RWS/PRODUCT/FRG/202611/18/R012_1KM_FRG_202611181425.csv', content: frgCsv, deflate: false },
        { name: 'RWS/PRODUCT/FOG/202611/18/R012_1KM_FOG_202611181425.csv', content: fogCsv, deflate: true }
      ]);
      return { ok: true, status: 200, arrayBuffer: async () => zipBuf };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  try {
    // Road Risk 012 ZIP parsing (STORED + DEFLATE + station/place coordinate matching)
    const rrRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/road-risk?roadNum=012'), env);
    assert.equal(rrRes.status, 200);
    const rr = await rrRes.json();
    assert.equal(rr.roadNum, '012');
    assert.equal(rr.corridorSummary.maxIce, 3);
    assert.equal(rr.corridorSummary.iceLabel, '위험');
    assert.equal(rr.corridorSummary.maxFog, 1);
    assert.equal(rr.placeRisks['35.520,127.725'].stationName, '함양(도)');
    assert.equal(rr.placeRisks['35.520,127.725'].iceLevel, 2);
    assert.equal(rr.placeRisks['35.520,127.725'].iceLabel, '주의');
    assert.equal(rr.placeRisks['35.520,127.725'].fogLevel, 1);
    assert.equal(rr.placeRisks['35.697,128.447'].iceLevel, 3);
    assert.equal(rr.placeRisks['35.697,128.447'].iceLabel, '위험');
    // Observation (first road_stn_obs attempt times out -> second succeeds -> zero getUltraSrtNcst outbound call!)
    const obsRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/observation?lat=35.644&lon=127.910'), env);
    assert.equal(obsRes.status, 200);
    const obs = await obsRes.json();
    assert.equal(obs.name, 'Namsang(Road)');
    assert.equal(obs.roadTemp, 7.4);
    assert.equal(roadObsAttempt, 2);
    assert.equal(hitUrls.filter(u => u.includes('getUltraSrtNcst')).length, 0);

    // P2.5: /api/road-obs-trend (6h 30-min historical slots + 5m memory cache hit on 2nd call)
    const trendRes1 = await worker.fetch(new Request('https://bionda-api.workers.dev/api/road-obs-trend?line=14&hours=6'), env);
    assert.equal(trendRes1.status, 200);
    assert.ok(String(trendRes1.headers.get('cache-control')).includes('s-maxage=600'));
    const trend1 = await trendRes1.json();
    assert.equal(trend1.ok, true);
    assert.equal(trend1.line, '14');
    assert.equal(trend1.hours, 6);
    assert.ok(Array.isArray(trend1.times) && trend1.times.length >= 10);
    assert.ok(trend1.stations['14207'] && trend1.stations['14207'].tr.includes(7.4));
    assert.ok(!JSON.stringify(trend1).includes('worker-secret-test-key'));
    const roadCallsAfterFirst = hitUrls.filter(u => u.includes('road_stn_obs.php')).length;
    const trendRes2 = await worker.fetch(new Request('https://bionda-api.workers.dev/api/road-obs-trend?line=14&hours=6'), env);
    assert.equal(trendRes2.status, 200);
    assert.equal(hitUrls.filter(u => u.includes('road_stn_obs.php')).length, roadCallsAfterFirst, '2차 /api/road-obs-trend 호출은 5분 메모리 캐시 적중');

    // Forecast
    const fcstRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/forecast?lat=35.644&lon=127.910'), env);
    assert.equal(fcstRes.status, 200);
    const fcst = await fcstRes.json();
    assert.equal(fcst.ok, true);
    assert.equal(fcst.hours.length, 12);
    assert.ok(!JSON.stringify(fcst).includes('worker-secret-test-key'));

    // Short-term regional single API call
    const s12Res = await worker.fetch(new Request('https://bionda-api.workers.dev/api/short-term-12'), env);
    assert.equal(s12Res.status, 200);
    const s12 = await s12Res.json();
    assert.equal(s12.ok, true);
    assert.equal(s12.regions.length, 13);
    assert.equal(s12.uniqueGridCount, 12);
    assert.equal(s12.windowKPIs.h12.wetRegions, 13);
    assert.ok(s12.windowKPIs.h12.freezingRegions >= 1);
    assert.ok(s12.windowKPIs.h12.overlapRegions >= 1);
    assert.ok(!JSON.stringify(s12).includes('worker-secret-test-key'));

    // Selective [새로고침] force=1&refreshShort=0&refreshUltra=1 bypasses only ultra cache, leaving VilageFcst cached
    const vilageBefore = hitUrls.filter(u => u.includes('getVilageFcst')).length;
    const ultraBefore = hitUrls.filter(u => u.includes('getUltraSrtFcst')).length;
    const s12UltraOnly = await worker.fetch(new Request('https://bionda-api.workers.dev/api/short-term-12?force=1&refreshShort=0&refreshUltra=1'), env);
    assert.equal(s12UltraOnly.status, 200);
    assert.equal(s12UltraOnly.headers.get('cache-control'), 'no-store');
    const vilageAfter = hitUrls.filter(u => u.includes('getVilageFcst')).length;
    const ultraAfter = hitUrls.filter(u => u.includes('getUltraSrtFcst')).length;
    assert.equal(vilageAfter, vilageBefore, 'refreshShort=0 시 단기예보 격자 캐시 유지');
    assert.ok(ultraAfter >= ultraBefore + 12, 'refreshUltra=1 시 12격자 초단기예보 강제 재조회');

    // Warnings (EUC-KR decoding verification!)
    const wrnRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/warnings?name=' + encodeURIComponent('거창군남부') + '&lat=35.644&lon=127.910'), env);
    assert.equal(wrnRes.status, 200);
    const wrn = await wrnRes.json();
    assert.equal(wrn.warnings.length, 1);
    assert.equal(wrn.warnings[0].title, '한파주의보');
    assert.equal(wrn.warnings[0].regKo, '거창군남부');

    // Overview bundle single-request API (8 places/subset + roadStations + roadRisk + warnings + forecast + obs)
    const bundleUrl = 'https://bionda-api.workers.dev/api/overview-bundle?line=14&roadNum=012&places=' +
      encodeURIComponent('거창군남부|35.644,127.910;함양중부|35.566,127.774');
    const bdlRes = await worker.fetch(new Request(bundleUrl), env);
    assert.equal(bdlRes.status, 200);
    const bdl = await bdlRes.json();
    assert.equal(bdl.ok, true);
    assert.equal(bdl.mode, 'overview-bundle');
    assert.ok(Array.isArray(bdl.roadStations) && bdl.roadStations.length >= 1);
    assert.equal(bdl.roadRisk?.ok, true);
    assert.equal(bdl.items['35.644,127.910']?.warnings?.[0]?.title, '한파주의보');
    assert.equal(bdl.items['35.644,127.910']?.forecast?.ok, true);
    assert.equal(bdl.items['35.566,127.774']?.observation?.roadTemp, 7.4);
    assert.equal(bdl.items['35.566,127.774']?.observation?.temp, 6.6);
    assert.ok(!JSON.stringify(bdl).includes('worker-secret-test-key'));

    // Radar binary PNG
    const rdrRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/radar'), env);
    assert.equal(rdrRes.status, 200);
    assert.equal(rdrRes.headers.get('content-type'), 'image/png');

    // Open-Meteo 429 propagation
    const omRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/open-meteo?endpoint=ensemble&latitude=35.644&longitude=127.910'), env);
    assert.equal(omRes.status, 429);
  } finally {
    global.fetch = beforeFetch;
  }

  // 3. Standalone single-file Quick-Edit bundle builds cleanly and passes syntax/import check
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-worker-bundle.js')], { stdio: 'pipe' });
  const standalonePath = path.join(__dirname, '..', 'dist', 'bionda-worker.standalone.js');
  const standaloneMod = await import(pathToFileURL(standalonePath).href);
  assert.equal(typeof standaloneMod.default?.fetch, 'function');
  const stHealth = await standaloneMod.default.fetch(new Request('https://bionda-api.workers.dev/api/health'), env);
  assert.equal(stHealth.status, 200);
});

test('Pages Gateway([[path]].js)는 정적 스냅샷 JSON·이미지를 context.next()로 통과시키고 API만 Worker로 전달한다', async () => {
  const { onRequest } = await import(pathToFileURL(path.join(__dirname, '..', 'functions', 'api', '[[path]].js')).href);
  const forwarded = [];
  const nextCalled = [];

  const makeCtx = (url, method = 'GET') => ({
    request: new Request(url, { method }),
    env: {
      API_WORKER: {
        fetch: async req => {
          forwarded.push(new URL(req.url).pathname);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
      }
    },
    next: () => {
      nextCalled.push(new URL(url).pathname);
      return new Response('static-ok', { status: 200 });
    },
    waitUntil: () => {}
  });

  for (const staticPath of [
    'https://bionda.pages.dev/api/snapshot.json',
    'https://bionda.pages.dev/api/short-term-12.json',
    'https://bionda.pages.dev/api/briefing.json',
    'https://bionda.pages.dev/api/radar.png',
    'https://bionda.pages.dev/api/briefing/goryeong-2026-11-19-0800.jpg'
  ]) {
    const res = await onRequest(makeCtx(staticPath));
    assert.equal(res.status, 200);
  }
  assert.deepEqual(nextCalled, [
    '/api/snapshot.json',
    '/api/short-term-12.json',
    '/api/briefing.json',
    '/api/radar.png',
    '/api/briefing/goryeong-2026-11-19-0800.jpg'
  ]);
  assert.equal(forwarded.length, 0);

  await onRequest(makeCtx('https://bionda.pages.dev/api/health'));
  await onRequest(makeCtx('https://bionda.pages.dev/api/kma-cap?file=KR.W2611108_202611181600_WWA_108_KR.xml'));
  assert.deepEqual(forwarded, ['/api/health', '/api/kma-cap']);
});

test('Worker 일괄 특보(?places=), 특보 20분 stale 복구, 번들 순서 정규화, data.go.kr 403 차단을 검증한다', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'cloudflare', 'worker.js')).href);
  const worker = mod.default;
  mod.__resetWorkerCaches();

  const env = { KMA_SERVICE_KEY: 'worker-secret-test-key', ROAD_LINE_CODE: '14' };
  const beforeFetch = global.fetch;
  const realDateNow = Date.now;
  let nowOffset = 0;
  Date.now = () => realDateNow() + nowOffset;

  let wrnFail = false;
  const hitUrls = [];
  const pad = n => String(n).padStart(2, '0');
  const nowKst = new Date(Date.now() + 9 * 3600000);
  nowKst.setUTCMinutes(0, 0, 0);
  const mkFcstItems = (resName) => {
    const items = [];
    for (let i = 1; i <= 6; i++) {
      const d = new Date(nowKst.getTime() + i * 3600000);
      const fcstDate = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      const fcstTime = `${pad(d.getUTCHours())}00`;
      items.push({ fcstDate, fcstTime, category: 'PTY', fcstValue: '0' });
      items.push({ fcstDate, fcstTime, category: 'POP', fcstValue: '10' });
      items.push({ fcstDate, fcstTime, category: resName === 'getUltraSrtFcst' ? 'RN1' : 'PCP', fcstValue: '강수없음' });
      items.push({ fcstDate, fcstTime, category: resName === 'getUltraSrtFcst' ? 'T1H' : 'TMP', fcstValue: '5.0' });
    }
    return items;
  };

  global.fetch = async (input) => {
    const u = String(input);
    hitUrls.push(u);
    if (u.includes('wrn_now_data.php')) {
      if (wrnFail) throw new Error('The operation was aborted due to timeout');
      const linePrefix = Buffer.from('L1083300, ', 'ascii');
      const geochang = Buffer.from([0xB0, 0xC5, 0xC3, 0xA2, 0xB1, 0xBA]); // 거창군
      const midComma = Buffer.from(', L1083320, ', 'ascii');
      const geochangSouth = Buffer.from([0xB0, 0xC5, 0xC3, 0xA2, 0xB1, 0xBA, 0xB3, 0xB2, 0xBA, 0xCE]); // 거창군남부
      const dates = Buffer.from(', 202611181100, 202611182100, ', 'ascii');
      const hanpa = Buffer.from([0xC7, 0xD1, 0xC6, 0xC4]); // 한파
      const midComma2 = Buffer.from(', ', 'ascii');
      const juuibo = Buffer.from([0xC1, 0xD6, 0xC0, 0xC7]); // 주의
      const balpyo = Buffer.from([0xB9, 0xDF, 0xC7, 0xA5]); // 발표
      const endLine = Buffer.from(', 20th AM,=\n', 'ascii');
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.concat([linePrefix, geochang, midComma, geochangSouth, dates, hanpa, midComma2, juuibo, midComma2, balpyo, endLine]) };
    }
    if (u.includes('apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/')) {
      const parsedU = new URL(u);
      const nx = parsedU.searchParams.get('nx');
      // nx=60 (서울) apihub 지연 시뮬레이션 → data.go.kr 403 확인용
      if (nx === '60') throw new Error('Simulated apihub timeout');
      const resName = parsedU.pathname.split('/').at(-1);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'OK' }, body: { items: { item: mkFcstItems(resName) } } } })
      };
    }
    if (u.includes('apis.data.go.kr')) {
      return { ok: false, status: 403, text: async () => 'Forbidden' };
    }
    if (u.includes('road_stn_obs.php')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('#START7777\n 202611182200, 14207, Namsang, Route12, Base, 35.6366, 127.9066, 220, 1, 7.4, 48448, 77.0, 0.0, 0.0, 6.6, 216.1, 1.7, 222.0, 2.3, 1014, -999, -999, -999, -999\n#7777END', 'utf8')
      };
    }
    if (u.includes('road_file_down.php')) {
      const zipBuf = makeTestZip([
        { name: 'RWS/PRODUCT/FRG/202611/18/R012_1KM_FRG_202611181425.csv', content: 'LINK_ID,S_NUM,F_LON,F_LAT,T_LON,T_LAT,B_ICE,FLAG,X_GRID,Y_GRID\n1570030500,1,127.90,35.64,127.91,35.65,1,0,350,300', deflate: false }
      ]);
      return { ok: true, status: 200, arrayBuffer: async () => zipBuf };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  try {
    // 1) 일괄 /api/warnings?places=... 동작 검증
    const bWrnRes = await worker.fetch(new Request(
      'https://bionda.pages.dev/api/warnings?places=' + encodeURIComponent('거창군남부|35.644,127.910;함양중부|35.566,127.774')
    ), env);
    assert.equal(bWrnRes.status, 200);
    const bWrn = await bWrnRes.json();
    assert.equal(bWrn.mode, 'batch');
    assert.equal(bWrn.stale, false);
    assert.equal(bWrn.items['35.644,127.910'].warnings[0].title, '한파주의보');
    assert.equal(bWrn.items['35.566,127.774'].warnings.length, 0);

    // 2) 95초 후 KMA 특보 타임아웃 발생 시 502 대신 stale: true(200)로 직전 특보 유지
    nowOffset += 95000;
    wrnFail = true;
    const staleWrnRes = await worker.fetch(new Request(
      'https://bionda.pages.dev/api/warnings?places=' + encodeURIComponent('함양중부|35.566,127.774;거창군남부|35.644,127.910')
    ), env);
    assert.equal(staleWrnRes.status, 200);
    const staleWrn = await staleWrnRes.json();
    assert.equal(staleWrn.stale, true);
    assert.equal(staleWrn.items['35.644,127.910'].warnings[0].title, '한파주의보');

    // 3) /api/overview-bundle 순서 무관 정규화 캐시 적중
    const b1Res = await worker.fetch(new Request(
      'https://bionda.pages.dev/api/overview-bundle?line=14&roadNum=012&places=' +
      encodeURIComponent('거창군남부|35.6440,127.9100;함양중부|35.5660,127.7740')
    ), env);
    assert.equal(b1Res.status, 200);
    const hitsAfterFirstBundle = hitUrls.length;
    const b2Res = await worker.fetch(new Request(
      'https://bionda.pages.dev/api/overview-bundle?line=14&roadNum=012&places=' +
      encodeURIComponent('함양중부|35.566,127.774;거창군남부|35.644,127.910')
    ), env);
    assert.equal(b2Res.status, 200);
    assert.equal(hitUrls.length, hitsAfterFirstBundle, '정규화 캐시키로 순서 변경 시 재호출 0회');

    // 4) ApiHub 키의 data.go.kr HTTP 403 negative cache (직전 base 폴백 및 후속 격자에서 data.go.kr 스킵)
    await worker.fetch(new Request('https://bionda.pages.dev/api/forecast?lat=37.5665&lon=126.9780'), env);
    const dataGoKrCallsFirst = hitUrls.filter(u => u.includes('apis.data.go.kr')).length;
    assert.ok(dataGoKrCallsFirst >= 1 && dataGoKrCallsFirst <= 3, `동시 3리소스 최초 403 이후 직전 base 폴백은 즉시 skip-host 적용(실제: ${dataGoKrCallsFirst})`);
    await worker.fetch(new Request('https://bionda.pages.dev/api/forecast?lat=37.5600&lon=126.9800'), env);
    const dataGoKrCallsSecond = hitUrls.filter(u => u.includes('apis.data.go.kr')).length;
    assert.equal(dataGoKrCallsSecond, dataGoKrCallsFirst, '동일 ttl 내 후속 요청도 data.go.kr 403 재호출 안 함');
  } finally {
    Date.now = realDateNow;
    global.fetch = beforeFetch;
  }
});

test('프런트엔드 fetchBatchWarnings는 1회 일괄 호출 및 실패 시 CAP 3분 쿨다운을 지킨다', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'warnings.js')).href);
  const { fetchBatchWarnings } = mod;

  const beforeFetch = global.fetch;
  const beforeWindow = global.window;
  const beforeDomParser = global.DOMParser;
  const calledPaths = [];

  let backendFail = false;
  global.window = { location: { hostname: 'bionda.pages.dev', protocol: 'https:' } };
  global.DOMParser = class {
    parseFromString() {
      return {
        documentElement: { localName: 'rss' },
        querySelectorAll: () => []
      };
    }
  };
  global.fetch = async (input) => {
    const u = String(input);
    calledPaths.push(u);
    if (u.includes('/api/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }
    if (u.includes('/api/warnings?places=')) {
      if (backendFail) return { ok: false, status: 502, json: async () => ({ error: 'upstream fail' }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          mode: 'batch',
          stale: false,
          items: {
            '35.644,127.910': { name: '거창군남부', warnings: [{ kind: '한파', level: '주의보', title: '한파주의보', regId: 'L1083320', regKo: '거창군남부', tmFc: '202611190600', effectiveText: '11-19 06:00', isFutureEffective: false }] },
            '35.566,127.774': { name: '함양중부', warnings: [] }
          }
        })
      };
    }
    if (u.includes('./api/snapshot.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          warnings: {
            '35.644,127.910': { warnings: [{ kind: '한파', level: '주의보', title: '한파주의보', regId: 'SNAP', regKo: '거창군남부', tmFc: '202611190500', effectiveText: '11-19 05:00' }] }
          }
        })
      };
    }
    if (u.includes('/api/kma-cap')) {
      return { ok: true, status: 200, text: async () => '<rss></rss>' };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    const res = await fetchBatchWarnings([
      { name: '거창군남부', lat: 35.644, lon: 127.910 },
      { name: '함양중부', lat: 35.566, lon: 127.774 }
    ]);
    assert.equal(res.ok, true);
    assert.equal(calledPaths.filter(u => u.includes('/api/warnings')).length, 1);
    assert.equal(res.resultsByKey.get('35.644,127.910').top.title, '한파주의보');
    assert.equal(res.resultsByKey.get('35.566,127.774').count, 0);

    // 백엔드 502 장애 시: 스냅샷 복원 + 1회 CAP 조회 후 동일 3분 내 재호출은 CAP RSS 스킵
    backendFail = true;
    const fail1 = await fetchBatchWarnings([
      { name: '거창군남부', lat: 35.644, lon: 127.910 },
      { name: '함양중부', lat: 35.566, lon: 127.774 }
    ]);
    assert.equal(fail1.ok, false);
    assert.equal(fail1.resultsByKey.get('35.644,127.910').top.title, '한파주의보');
    const capAfterFirstFail = calledPaths.filter(u => u.includes('kma-cap')).length;
    assert.equal(capAfterFirstFail, 1);

    await fetchBatchWarnings([
      { name: '거창군남부', lat: 35.644, lon: 127.910 },
      { name: '함양중부', lat: 35.566, lon: 127.774 }
    ]);
    assert.equal(calledPaths.filter(u => u.includes('kma-cap')).length, capAfterFirstFail, '3분 쿨다운 동안 CAP RSS 중복 호출 차단');
  } finally {
    global.fetch = beforeFetch;
    global.window = beforeWindow;
    global.DOMParser = beforeDomParser;
  }
});

test('Pages compares Gaya and Yaro when the bound Worker still returns 11 grids', async () => {
  const { onRequest } = await import('../functions/api/[[path]].js');
  const snapshot = require('../public/api/short-term-12.json');
  const yaro = snapshot.regions.find(r => r.id === 'yaro');
  const legacy = { ...snapshot, uniqueGridCount: 11, regions: snapshot.regions.filter(r => r.id !== 'gaya') };
  const calls = [];
  let batch = legacy;
  let point = {
    ok: true, grid: { nx: 81, ny: 88 }, sources: yaro.sources,
    hours: [{ time: yaro.hours[0].time, temp: '-11', chance: 80, wet: true, rainMm: 1 }]
  };
  const ctx = {
    request: new Request('https://bionda.pages.dev/api/short-term-12?force=1'),
    env: { API_WORKER: { fetch: async req => {
      const url = new URL(req.url);
      calls.push(url);
      return Response.json(url.pathname === '/api/forecast' ? point : batch);
    } } }
  };
  const merged = await (await onRequest(ctx)).json();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].pathname, '/api/forecast');
  assert.equal(calls[1].searchParams.get('lat'), '35.762683');
  assert.equal(calls[1].searchParams.get('lon'), '128.139463');
  assert.equal(calls[1].searchParams.get('force'), '1');
  assert.equal(merged.regions.length, 13);
  assert.equal(merged.uniqueGridCount, 12);
  const gaya = merged.regions.find(r => r.id === 'gaya');
  assert.equal(gaya.hours[0].temp, -11);
  assert.equal(gaya.hours[0].pop, 80);
  assert.equal(gaya.hours[0].hourKst, yaro.hours[0].hourKst);
  assert.equal(gaya.summaries.h12.overlapHours, 1);
  assert.deepEqual(merged.regions.find(r => r.id === 'yaro').hours, yaro.hours);

  point = { ...point, grid: yaro.grid };
  const delayed = await (await onRequest(ctx)).json();
  assert.deepEqual(delayed.regions.find(r => r.id === 'gaya').hours, []);

  calls.length = 0;
  batch = merged;
  assert.deepEqual(await (await onRequest(ctx)).json(), merged);
  assert.equal(calls.length, 1);
});
