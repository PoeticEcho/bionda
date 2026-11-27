const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const core = require('../lib/bionda-core');

test('Fix 1 (기상청 SFS 노면상태 공식 코드): SFS=14(습기) 정밀 표기·영상 온도 오경보 방지·저온 예비살포 감지를 검증한다', async () => {
  // 1) 공식 KMA SFS 코드 테이블 검증
  assert.equal(core.SURFACE_STATES[1], '건조');
  assert.equal(core.SURFACE_STATES[2], '습윤');
  assert.equal(core.SURFACE_STATES[3], '적설');
  assert.equal(core.SURFACE_STATES[4], '결빙');
  assert.equal(core.SURFACE_STATES[10], '저시정');
  assert.equal(core.SURFACE_STATES[11], '수막');
  assert.equal(core.SURFACE_STATES[12], '화학습윤');
  assert.equal(core.SURFACE_STATES[13], '임계습윤');
  assert.equal(core.SURFACE_STATES[14], '습기');
  assert.equal(core.SURFACE_STATES[15], '눈·결빙');

  // 2) parseRoadStations & mergeObservationResult: SFS=14 -> '습기' ('관측중'이나 적색 결빙 오표기 금지)
  const rawCsv = [
    '# START7777',
    '202611270615, 14209, 양전교(도), 무안광주대구선, 일반, 35.7180, 128.2320, 92, 14, 11.5, 2000, 82.0, 0.0, 0.0, 12.4, 270.0, 1.8, 0.0, 3.1, 1015.2'
  ].join('\n');
  const parsed = core.parseRoadStations(rawCsv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].surfaceCode, 14);
  assert.equal(parsed[0].surfaceState, '습기');

  const mergedWarmDamp = core.mergeObservationResult(parsed[0], null);
  assert.equal(mergedWarmDamp.description, null, '영상 습기(SFS=14)는 하늘 상태 설명을 노면 위험문구로 덮어쓰지 않아야 함');

  const mergedIce = core.mergeObservationResult({ ...parsed[0], surfaceCode: 4, surfaceState: '결빙' }, null);
  assert.equal(mergedIce.description, '노면 결빙');

  // 3) classifyPresaltConditionRow: 영상 습기(정상) vs 저온 습기(예비살포조건) vs SFS=4/15(실측결빙)
  assert.equal(core.classifyPresaltConditionRow({ temp: 12.4, roadTemp: 11.5, surfaceCode: 14, dayPrecip: 0 }).flag, 'normal');
  assert.equal(core.classifyPresaltConditionRow({ temp: 2.8, roadTemp: 1.4, surfaceCode: 14, dayPrecip: 0 }).flag, 'presalt');
  assert.equal(core.classifyPresaltConditionRow({ temp: -0.5, roadTemp: -1.2, surfaceCode: 4, dayPrecip: 0 }).flag, 'ice');
  assert.equal(core.classifyPresaltConditionRow({ temp: -1.0, roadTemp: -1.8, surfaceCode: 15, dayPrecip: 0 }).flag, 'ice');
  assert.equal(core.classifyPresaltConditionRow({ temp: 1.5, roadTemp: 1.2, surfaceCode: 10, dayPrecip: 0 }).flag, 'cold', '저시정(10) 단독은 습윤 예비살포가 아닌 노면저온으로 분류');

  // 4) public/ice.js & public/rwis-data.js 연동 검증
  const { classifySeverityTier, iceOutlook } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'ice.js')).href);
  const { enrichZonesWithBionda, evaluateMeasuredPresaltAlerts } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'rwis-data.js')).href);

  // 영상 11.5°C + SFS=14(습기) -> 평온(tier 0, 회색/하늘색) 유지 (과거 SFS>=4 적색 오경보 해소)
  const warmDampTier = classifySeverityTier({
    w: { current: { code: 1, precip: 0 }, ice: { rank: 0, decisionCards: [] }, kma: { analysis: { now: { wet: false } } } },
    o: { temp: 12.4, roadTemp: 11.5, surfaceCode: 14, surfaceState: '습기', precip: 0 },
    wrn: { count: 0 }
  });
  assert.equal(warmDampTier.tier, 0);

  // 저온 1.6°C + SFS=14(습기) -> curSurfaceWet=true 및 측정 예비살포 알림 정상 작동
  const coldDampIce = iceOutlook(
    { time: '2026-11-27T04:00', temp: 2.0, humidity: 85, wind: 1.5, code: 1, precip: 0, snow: 0 },
    [],
    [{ time: '2026-11-27T05:00', temp: 1.2, humidity: 86, wind: 1.4, code: 1, precip: 0, snow: 0 }],
    { temp: 2.0, roadTemp: 1.6, humidity: 85, surfaceCode: 14, surfaceState: '습기', dayPrecip: 0 }
  );
  assert.equal(coldDampIce.curSurfaceWet, true);
  assert.equal(coldDampIce.curSurfaceState, '습기');

  const alerts = evaluateMeasuredPresaltAlerts({
    roadStations: [
      { stnId: '14209', name: '양전교(도)', roadTemp: 11.5, temp: 12.4, surfaceCode: 14, surfaceState: '습기', dayPrecip: 0 },
      { stnId: '14409', name: '죽산천교(도)', roadTemp: 1.4, temp: 2.5, surfaceCode: 14, surfaceState: '습기', dayPrecip: 0 }
    ],
    nowMs: Date.parse('2026-11-27T05:00:00+09:00')
  });
  assert.equal(alerts.corridorHits.length, 1, '영상 습기 관측소는 제외하고 저온 습기 관측소만 예비살포 알림 대상이어야 함');
  assert.equal(alerts.corridorHits[0].stnId, '14409');
  assert.ok(alerts.corridorHits[0].reason.includes('습기'));

  // 같은 구간 내 결빙(SFS=4)과 습기(SFS=14)가 공존할 때 숫자 크기(14>4)가 아닌 위험도 순위(결빙>습기)로 대표 노면상태 채택
  const enrichedRes = enrichZonesWithBionda({
    roadStations: [
      { stnId: '14103', name: '논공휴(도)', roadTemp: 2.0, temp: 2.5, surfaceCode: 14, surfaceState: '습기' },
      { stnId: '14410', name: '논공교(도)', roadTemp: -0.6, temp: 0.5, surfaceCode: 4, surfaceState: '결빙' }
    ]
  });
  const zoneList = Array.isArray(enrichedRes) ? enrichedRes : enrichedRes.zones;
  const okpoZone = zoneList.find(z => z.suffix === '230');
  assert.equal(okpoZone.roadObs.surfaceCode, 4);
  assert.equal(okpoZone.roadObs.surfaceState, '결빙');
});

test('Fix 2 (ICON 앙상블 6h 기온 정합성): Open-Meteo 광역 기온(7.6~7.7°C) 대신 기상청 시간별 예보 기온(4~5°C)으로 동기화한다', async () => {
  const { loadWeather } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'weather.js')).href);
  const beforeFetch = global.fetch;

  const baseDateMs = Date.parse('2026-11-27T03:00:00+09:00');
  const realDateNow = Date.now;
  Date.now = () => baseDateMs + 5 * 60000; // 03:05 KST

  const omTimes = [];
  const omTemps = [];
  const kmaHours = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(baseDateMs + i * 3600000 + 9 * 3600000);
    const localIso = d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:00
    omTimes.push(localIso);
    omTemps.push(Number((7.6 + i * 0.02).toFixed(1))); // Open-Meteo coarse 7.6~7.7°C
    kmaHours.push({
      time: `${localIso}:00+09:00`,
      temp: i < 3 ? 4 : 5, // KMA local valley cooling 4~5°C
      humidity: 88,
      wind: 1.6,
      chance: 20,
      wet: false,
      rainMm: 0,
      snowCm: 0,
      type: '없음',
      skyLabel: '구름많음',
      source: '초단기예보'
    });
  }

  global.fetch = async (input) => {
    const u = String(input);
    if (u.includes('/api/health')) {
      return Response.json({ status: 'ok', forecastConfigured: true, roadConfigured: true });
    }
    if (u.includes('/api/open-meteo') || u.includes('api.open-meteo.com/v1/forecast')) {
      return Response.json({
        current: { time: omTimes[0], temperature_2m: 7.5, relative_humidity_2m: 75, wind_speed_10m: 2.1, weather_code: 2, precipitation: 0 },
        hourly: {
          time: omTimes,
          temperature_2m: omTemps,
          relative_humidity_2m: omTimes.map(() => 75),
          wind_speed_10m: omTimes.map(() => 2.1),
          weather_code: omTimes.map(() => 2),
          precipitation_probability: omTimes.map(() => 10),
          precipitation: omTimes.map(() => 0),
          rain: omTimes.map(() => 0),
          snowfall: omTimes.map(() => 0)
        }
      });
    }
    if (u.includes('/api/forecast')) {
      return Response.json({
        ok: true,
        hours: kmaHours,
        analysis: { now: { wet: false, temp: 4 } }
      });
    }
    throw new Error('Unexpected fetch: ' + u);
  };

  try {
    const res = await loadWeather({ name: '고령군', lat: 35.728, lon: 128.263 }, null, {});
    // rows는 reference(03:00) 이후 +1..+6시간(04:00~09:00)을 슬라이스하므로 kmaHours[1..6]과 대응: [4, 4, 5, 5, 5, 5]
    assert.equal(res.rows.length, 6);
    assert.deepEqual(
      res.rows.map(r => r.temp),
      [4, 4, 5, 5, 5, 5],
      '앞으로 6시간(ICON 앙상블) 표의 기온은 상단 기상청 타임라인과 동일하게 4~5°C로 일치해야 함'
    );
    assert.equal(res.rows[0].omTemp, 7.6, '원본 Open-Meteo 기온은 omTemp로 보존');
    assert.equal(res.ice.minTemp, 4, '살얼음 판정 엔진도 7.6°C가 아닌 기상청 4°C를 기준으로 평가해야 함');
  } finally {
    global.fetch = beforeFetch;
    Date.now = realDateNow;
  }
});

test('Fix 3 (/hourly 공유 Last-Good 스냅샷 SWR): 콜드 만료 시 직전 성공 스냅샷을 즉시 반환하고 백그라운드에서 최신화한다', async () => {
  const { onRequest } = await import(pathToFileURL(path.join(__dirname, '..', 'functions', 'api', '[[path]].js')).href);
  const { __resetPagesHourlyState } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'hourly-roster.mjs')).href);
  const { alignClientHourlyPayload } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'hourly.js')).href);
  __resetPagesHourlyState();

  const snapshot = require('../public/api/short-term-12.json');
  const realDateNow = Date.now;
  const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');

  // 스냅샷의 첫 번째 시간으로부터 +2시간 경과한 시점 시뮬레이션
  const firstHourMs = Date.parse(snapshot.regions[0].hours[0].time);
  const baseNowMs = firstHourMs + 2 * 3600000 + 10 * 60000; // HH+2:10 KST
  Date.now = () => baseNowMs;

  // 1) alignShortTermSnapshotToNow & alignClientHourlyPayload 검증 (지난 2시간 제거 + 요약 재계산)
  const seededSnap = { ...snapshot, updatedAt: new Date(firstHourMs + 5 * 60000).toISOString() };
  const alignedCore = core.alignShortTermSnapshotToNow(seededSnap, baseNowMs);
  assert.ok(alignedCore);
  assert.equal(alignedCore.sources.servedFromLastGood, true);
  assert.equal(Date.parse(alignedCore.regions[0].hours[0].time), firstHourMs + 2 * 3600000);

  const alignedClient = alignClientHourlyPayload(seededSnap, baseNowMs);
  assert.ok(alignedClient);
  assert.equal(Date.parse(alignedClient.regions[0].hours[0].time), firstHourMs + 2 * 3600000);

  // 2) Pages Edge Cache (Fresh + Last-Good) 시뮬레이션
  const store = new Map();
  let dropFresh = false;
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      default: {
        async match(req) {
          const key = typeof req === 'string' ? req : req.url;
          if (dropFresh && key.includes('/fresh/')) return undefined;
          const val = store.get(key);
          return val ? val.clone() : undefined;
        },
        async put(req, res) {
          const key = typeof req === 'string' ? req : req.url;
          store.set(key, res.clone());
        }
      }
    }
  });

  let upstreamCalls = 0;
  let currentShortBase = '2026-11-27T08:00:00+09:00';
  const waitUntilPromises = [];

  const makeCtx = (url, headers = {}) => ({
    request: new Request(url, { headers }),
    env: {
      API_WORKER: {
        fetch: async () => {
          upstreamCalls++;
          const updated = {
            ...seededSnap,
            updatedAt: new Date(Date.now()).toISOString(),
            sources: { ...seededSnap.sources, shortBase: currentShortBase }
          };
          return Response.json(updated);
        }
      }
    },
    waitUntil: p => waitUntilPromises.push(p)
  });

  try {
    // Step A: 최초 시드 요청 -> MISS-SEED, Fresh + Last-Good 모두 저장
    const res1 = await onRequest(makeCtx('https://bionda.pages.dev/api/short-term-12?roster=13'));
    assert.equal(res1.headers.get('x-bionda-cache'), 'MISS-SEED');
    assert.equal(upstreamCalls, 1);
    await Promise.all(waitUntilPromises.splice(0));

    // Step B: 두 번째 방문자 -> HIT-FRESH 즉시 반환 (상류 호출 0회)
    const res2 = await onRequest(makeCtx('https://bionda.pages.dev/api/short-term-12?roster=13'));
    assert.equal(res2.headers.get('x-bionda-cache'), 'HIT-FRESH');
    assert.equal(upstreamCalls, 1);

    // Step C: :35 / 정시 경계 경과로 Fresh 캐시 만료 시뮬레이션 + 새 발표회차(11:00) 개방
    dropFresh = true;
    currentShortBase = '2026-11-27T11:00:00+09:00';
    const res3 = await onRequest(makeCtx('https://bionda.pages.dev/api/short-term-12?roster=13'));
    assert.equal(res3.headers.get('x-bionda-cache'), 'HIT-LAST-GOOD-SWR', 'Fresh 만료 시에도 대기 없이 공유 Last-Good 스냅샷 즉시 반환');
    const body3 = await res3.json();
    assert.equal(body3.sources.servedFromLastGood, true);
    assert.equal(body3.sources.shortBase, '2026-11-27T08:00:00+09:00');

    // waitUntil 백그라운드 갱신이 완료되면 Fresh + Last-Good 모두 11:00 회차로 자동 교체됨
    await Promise.all(waitUntilPromises);
    dropFresh = false;
    const res4 = await onRequest(makeCtx('https://bionda.pages.dev/api/short-term-12?roster=13'));
    assert.equal(res4.headers.get('x-bionda-cache'), 'HIT-FRESH');
    const body4 = await res4.json();
    assert.equal(body4.sources.shortBase, '2026-11-27T11:00:00+09:00');
    assert.equal(body4.sources.servedFromLastGood, false);

    // Step D: 야간 아카이브 봇(Bionda-Night-Weather)은 Fresh 만료 시 Last-Good 대신 실시간 원천을 직접 대기
    dropFresh = true;
    currentShortBase = '2026-11-27T14:00:00+09:00';
    const resBot = await onRequest(makeCtx('https://bionda.pages.dev/api/short-term-12?roster=13', {
      'User-Agent': 'Bionda-Night-Weather/1.0 (+https://bionda.pages.dev/llms.txt)'
    }));
    const bodyBot = await resBot.json();
    assert.equal(bodyBot.sources.shortBase, '2026-11-27T14:00:00+09:00');
  } finally {
    if (cachesDescriptor) Object.defineProperty(globalThis, 'caches', cachesDescriptor);
    else delete globalThis.caches;
    Date.now = realDateNow;
    __resetPagesHourlyState();
  }
});

test('Fix 4 (night.png 스케줄 발행 복구): publish-share.py는 기본적으로 briefing.json을 수정하지 않아 CI git pull --rebase 충돌(exit 128)을 방지한다', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'publish-share.py');
  execFileSync('python', ['-m', 'py_compile', scriptPath]);
  const src = require('node:fs').readFileSync(scriptPath, 'utf8');
  assert.ok(src.includes('"--write-briefing"'), '--write-briefing 명시 플래그가 존재해야 함');
  assert.ok(src.includes('if not args.bootstrap and args.write_briefing:'), '기본 실행 시 public/api/briefing.json 미수정으로 워킹트리를 깨끗하게 유지해야 함');
});
