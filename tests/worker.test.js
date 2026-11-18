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
    for (let i = 1; i <= (resName === 'getUltraSrtFcst' ? 6 : 12); i++) {
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

    // Forecast
    const fcstRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/forecast?lat=35.644&lon=127.910'), env);
    assert.equal(fcstRes.status, 200);
    const fcst = await fcstRes.json();
    assert.equal(fcst.ok, true);
    assert.equal(fcst.hours.length, 12);
    assert.ok(!JSON.stringify(fcst).includes('worker-secret-test-key'));

    // Short-term 12-area single API call
    const s12Res = await worker.fetch(new Request('https://bionda-api.workers.dev/api/short-term-12'), env);
    assert.equal(s12Res.status, 200);
    const s12 = await s12Res.json();
    assert.equal(s12.ok, true);
    assert.equal(s12.regions.length, 12);
    assert.equal(s12.uniqueGridCount, 11);
    assert.equal(s12.windowKPIs.h12.wetRegions, 12);
    assert.ok(s12.windowKPIs.h12.freezingRegions >= 1);
    assert.ok(s12.windowKPIs.h12.overlapRegions >= 1);
    assert.ok(!JSON.stringify(s12).includes('worker-secret-test-key'));

    // Warnings (EUC-KR decoding verification!)
    const wrnRes = await worker.fetch(new Request('https://bionda-api.workers.dev/api/warnings?name=' + encodeURIComponent('거창군남부') + '&lat=35.644&lon=127.910'), env);
    assert.equal(wrnRes.status, 200);
    const wrn = await wrnRes.json();
    assert.equal(wrn.warnings.length, 1);
    assert.equal(wrn.warnings[0].title, '한파주의보');
    assert.equal(wrn.warnings[0].regKo, '거창군남부');

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
