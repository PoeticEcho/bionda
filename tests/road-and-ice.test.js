const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRoadStations, matchRoadStation, parseWrnNow, sortWarnings, analyze, warningMatchesPlace } = require('../server');

test('광주대구선(14번) 도로기상관측 매분자료 파싱 및 8개 관심지역 최근접 매칭', () => {
  const sampleRaw = [
    '#START7777',
    ' 202611181540, 14102, 지리산휴(도), 무안광주대구선, 거점, 35.4826, 127.5692, 469, 1, 11.1, 29766, 72.6, 1.5, 0.0, 7.0, 205.9, 2.7, 175.6, 4.8, 1014, 924, 7620, 7620, 8',
    ' 202611181540, 14207, 남상졸음(도), 무안광주대구선, 기본, 35.6366, 127.9066, 220, 1, 12.8, 48448, 58.9, 0.0, -999.0, 9.8, 216.1, 1.7, 222.0, 2.3, 1014, -999, -999, -999, -999',
    ' 202611181540, 14409, 죽산천교(도), 무안광주대구선, 목표(결빙), 35.5486, 127.8289, 186, 1, 11.6, -999, -999.0, -999.0, -999.0, -999.0, -999.0, -999.0, -999.0, -999.0, -999, -999, -999, -999, -999',
    '#7777END'
  ].join('\n');

  const stns = parseRoadStations(sampleRaw);
  assert.equal(stns.length, 3);
  assert.equal(stns[1].name, '남상졸음(도)');
  assert.equal(stns[1].roadTemp, 12.8);
  assert.equal(stns[1].temp, 9.8);
  assert.equal(stns[2].stationType, '목표(결빙)');
  assert.equal(stns[2].temp, null);
  assert.equal(stns[2].roadTemp, 11.6);
  assert.equal(stns[0].milepostKm, 75.4);
  assert.equal(stns[1].milepostKm, 115.3);
  assert.equal(stns[2].milepostKm, 102.9);

  // 거창군남부(남상면: 35.644, 127.910) 매칭 검증
  const matched = matchRoadStation(35.644, 127.910, stns);
  assert.equal(matched.name, '남상졸음(도)');
  assert.ok(matched.distanceKm < 1.5);
  assert.equal(matched.routeNo, '12');
  assert.equal(matched.milepostKm, 115.3);
  assert.equal(matched.temp, 9.8);
  assert.equal(matched.roadTemp, 12.8);
  assert.equal(matched.bridgeStationName, '죽산천교(도)');
  assert.equal(matched.bridgeMilepostKm, 102.9);
  assert.equal(matched.bridgeRoadTemp, 11.6);
});

test('기상특보 전종 파싱 및 도로관리 위험도 우선순위 정렬 (경보 > 주의보 > 예비특보, 대설/호우 > 한파/강풍)', () => {
  const sampleWrn = [
    '# REG_UP, REG_UP_KO, REG_ID, REG_KO, TM_FC, TM_EF, WRN, LVL, CMD, ED_TM',
    'L1083300, 거창군, L1083320, 거창군남부, 202611181100, 202611181100, 강풍, 주의, 발표, 19일 새벽(03시~06시),=',
    'L1083300, 거창군, L1083320, 거창군남부, 202611181100, 202611182100, 한파, 주의, 발표, 20일 낮(12시~15시),=',
    'L1083300, 거창군, L1083320, 거창군남부, 202611181400, 202611181400, 대설, 경보, 변경, 19일 오전(09시~12시),='
  ].join('\n');

  const parsed = parseWrnNow(sampleWrn);
  const sorted = sortWarnings(parsed);
  assert.equal(sorted.length, 3);
  assert.equal(sorted[0].title, '대설경보');
  assert.equal(sorted[1].title, '한파주의보');
  assert.equal(sorted[2].title, '강풍주의보');
  assert.equal(sorted[0].expiresText, '19일 오전(09시~12시)');
});

test('도로 살얼음 판정 (야간 교량 복사냉각, 잔설 재결빙, 3단계 제설 역산 타임라인, 호우 수방, 강풍)', async () => {
  const { iceOutlook, calcDewPoint } = await import('../public/ice.js');
  const dp = calcDewPoint(0, 92);
  assert.ok(dp <= 0 && dp >= -2);

  const current = { time: '2026-11-18T14:00', temp: 2.0, humidity: 85, wind: 2.0, code: 3, precip: 0 };
  const history = Array.from({ length: 24 }, (_, i) => ({
    time: `2026-11-18T${String(i).padStart(2, '0')}:00`,
    temp: 3,
    humidity: 80,
    wind: 2,
    code: 3,
    precip: i === 12 ? 1.2 : 0,
    snow: 0
  }));
  const forecast = [
    { time: '2026-11-18T15:00', temp: 1.8, humidity: 85, wind: 2, code: 3, precip: 0, snow: 0 },
    { time: '2026-11-18T16:00', temp: 1.2, humidity: 88, wind: 2, code: 3, precip: 0, snow: 0 },
    { time: '2026-11-18T17:00', temp: -0.5, humidity: 92, wind: 3, code: 71, precip: 1.5, snow: 1.4, snowPop: 85 },
    { time: '2026-11-18T18:00', temp: -2.0, humidity: 90, wind: 11.5, code: 71, precip: 1.2, snow: 1.2, snowPop: 80 },
    { time: '2026-11-18T19:00', temp: -4.0, humidity: 85, wind: 5, code: 3, precip: 0, snow: 0 },
    { time: '2026-11-18T20:00', temp: -6.5, humidity: 80, wind: 3, code: 3, precip: 0, snow: 0 }
  ];

  const outlook = iceOutlook(current, history, forecast, { temp: 1.9, roadTemp: 1.1 });
  assert.equal(outlook.level, '주의');
  assert.equal(outlook.rank, 2);
  // 17:00 강설·결빙 예상 -> 3시간 전(14:00) 시동·예열, 15:00~16:00 예비살포, 본제설, -6°C 저온 염화칼슘 안내 확인
  assert.ok(outlook.snowActions.some(a => a.stage === 'preheat' && a.text.includes('14:00')));
  assert.ok(outlook.snowActions.some(a => a.stage === 'presalt' && a.text.includes('15:00')));
  assert.ok(outlook.snowActions.some(a => a.stage === 'mainplow'));
  assert.ok(outlook.snowActions.some(a => a.stage === 'chemical'));
  assert.equal(outlook.windAlert.active, true);
  assert.equal(outlook.windAlert.maxWind, 11.5);
  // 구조화된 결빙 지표 6개 및 지시 카드 4개(제설차 시동 ON, 예비살포, 본살포, 수방·횡풍) 검증
  assert.equal(outlook.conditionMetrics.length, 6);
  assert.equal(outlook.decisionCards.length, 4);
  assert.equal(outlook.decisionCards[0].title, '제설차 시동 ON');
  assert.equal(outlook.decisionCards[0].subtitle, '(살포기 유압 예열)');
  assert.equal(outlook.decisionCards[1].title, '예비살포');
  assert.equal(outlook.decisionCards[2].title, '본살포');
});

test('19:00 ~ 06:00 12시간 전 구간 강수 시 시작·지속 분석 결과 검증', () => {
  const base = Date.parse('2026-11-18T18:00:00+09:00');
  const hours = Array.from({ length: 12 }, (_, i) => ({
    offset: i + 1,
    wet: true,
    risk: false,
    type: '비',
    chance: 80,
    time: new Date(base + (i + 1) * 3600000 + 9 * 3600000).toISOString().replace('Z', '+09:00').slice(0, 19) + '+09:00'
  }));
  // Construct exact KST ISO strings 19:00 .. 06:00
  const kstHours = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(base + (i + 1) * 3600000 + 9 * 3600000);
    const pad = x => String(x).padStart(2, '0');
    const t = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00:00+09:00`;
    return { offset: i + 1, wet: true, risk: false, type: '비', chance: 80, time: t };
  });
  const a = analyze(kstHours, { wet: false });
  assert.equal(a.windowHours, 12);
  assert.equal(a.allWindowWet, true);
  assert.equal(a.extendsBeyondWindow, true);
  assert.equal(a.end, null);
  assert.equal(a.start.time.slice(11, 16), '19:00');
  assert.equal(a.lastWetTime.slice(11, 16), '06:00');
  assert.equal(a.windowEndTime.slice(11, 16), '06:00');
});

test('스냅샷 및 공개 파일에 API 키 평문이 절대 포함되지 않는다', () => {
  const snapPath = path.join(__dirname, '..', 'public', 'api', 'snapshot.json');
  if (fs.existsSync(snapPath)) {
    const content = fs.readFileSync(snapPath, 'utf8');
    assert.ok(!content.includes('authKey='));
    assert.ok(!content.includes('serviceKey='));
    if (process.env.KMA_SERVICE_KEY && process.env.KMA_SERVICE_KEY !== 'dummy-do-not-expose') {
      assert.ok(!content.includes(process.env.KMA_SERVICE_KEY));
    }
  }
});

test('analyze() horizonRanges는 향후 3시간(1~3h), 3~6시간(4~6h), 향후 6~12시간(7~12h) 비중복 구간으로 분리 판정한다', () => {
  const base = Date.UTC(2026, 10, 18, 9, 0, 0);
  const pad = x => String(x).padStart(2, '0');
  const kstHours = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(base + (i + 1) * 3600000 + 9 * 3600000);
    const t = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00:00+09:00`;
    // Rain ONLY at offset 8 (within 6~12h window)
    const wet = i + 1 === 8;
    return { offset: i + 1, wet, risk: false, type: wet ? '비' : '없음', chance: wet ? 80 : 10, time: t };
  });
  const a = analyze(kstHours, { wet: false });
  assert.equal(a.horizonRanges.length, 3);
  assert.equal(a.horizonRanges[0].label, '향후 3시간');
  assert.equal(a.horizonRanges[0].hasPrecipitation, false);
  assert.equal(a.horizonRanges[1].label, '3~6시간');
  assert.equal(a.horizonRanges[1].hasPrecipitation, false);
  assert.equal(a.horizonRanges[2].label, '향후 6~12시간');
  assert.equal(a.horizonRanges[2].hasPrecipitation, true);
  assert.deepEqual(a.horizonRanges[2].kinds, ['비']);
});

test('iceOutlook은 6시간 판단 창을 유지하며 시동ON·예비살포 stageId 및 PC/모바일 칩(pcChip/mobChip)을 생성한다', async () => {
  const { iceOutlook } = await import('../public/ice.js');
  // 0~6h warm/clear, only hour +8 freezing -> must stay rank 0 in 6h horizon
  const rowsWarmAndLateFreeze = Array.from({ length: 10 }, (_, i) => ({
    time: `2026-11-18T${String(15 + i).padStart(2, '0')}:00`,
    temp: i < 7 ? 8.5 : -2.0,
    humidity: 70,
    wind: 2.0,
    precip: i < 7 ? 0 : 1.0,
    snow: 0,
    pop: i < 7 ? 10 : 80,
    code: i < 7 ? 0 : 71
  }));
  const calmRes = iceOutlook(
    { time: '2026-11-18T14:00', temp: 9.0, humidity: 65, wind: 2.0, precip: 0, code: 0 },
    [],
    rowsWarmAndLateFreeze,
    { roadTemp: 9.5, surfaceCode: 1, todayPrecip: 0 },
    []
  );
  assert.equal(calmRes.rank, 0);
  assert.equal(calmRes.decisionCards.filter(c => c.state !== 'idle').length, 0);

  // Sub-zero road & snow at hour +3 within 6h horizon -> active cards with pcChip & mobChip
  const rowsFreeze3h = Array.from({ length: 6 }, (_, i) => ({
    time: `2026-11-18T${String(15 + i).padStart(2, '0')}:00`,
    temp: i < 2 ? 2.5 : -1.8,
    humidity: 88,
    wind: 3.1,
    precip: i < 2 ? 0 : 1.2,
    snow: i < 2 ? 0 : 1.5,
    pop: i < 2 ? 20 : 90,
    code: i < 2 ? 3 : 73
  }));
  const urgentRes = iceOutlook(
    { time: '2026-11-18T14:00', temp: 2.5, humidity: 82, wind: 2.5, precip: 0, code: 3 },
    [],
    rowsFreeze3h,
    { roadTemp: 0.4, surfaceCode: 2, todayPrecip: 0.5 },
    []
  );
  assert.equal(urgentRes.rank, 2);
  const active = urgentRes.decisionCards.filter(c => c.state === 'urgent' || c.state === 'watch');
  assert.ok(active.length >= 2);
  for (const c of active) {
    assert.ok(c.stageId);
    assert.ok(c.pcChip && c.mobChip);
  }
});

test('classifySeverityTier는 4단계(회색->노랑->주황->빨강) 색상 등급 및 현재 눈·심한비 적색 격상을 정확히 분류한다', async () => {
  const { classifySeverityTier } = await import('../public/ice.js');

  // 0: Calm -> 회색 (tier 0)
  const tierCalm = classifySeverityTier({
    w: { current: { code: 1, precip: 0 }, ice: { rank: 0, decisionCards: [] }, kma: { analysis: { now: { wet: false } } } },
    o: { surfaceCode: 1, precip: 0 },
    wrn: { count: 0 }
  });
  assert.equal(tierCalm.tier, 0);
  assert.equal(tierCalm.cls, 'tier-calm');

  // 1: Light rain or general advisory (without directive) -> 노랑 (tier 1)
  const tierWatchRain = classifySeverityTier({
    w: { current: { code: 61, precip: 1.0 }, ice: { rank: 0, decisionCards: [] }, kma: { analysis: { now: { wet: true, type: '비' } } } },
    o: { surfaceCode: 2, precip: 1.0 },
    wrn: { count: 0 }
  });
  assert.equal(tierWatchRain.tier, 1);
  assert.equal(tierWatchRain.cls, 'tier-watch');

  // 2: Preheat / Presalt watch directive attached -> 주황 (tier 2)
  const tierDirective = classifySeverityTier({
    w: {
      current: { code: 3, precip: 0 },
      ice: { rank: 1, decisionCards: [{ stageId: 'preheat', state: 'watch' }] },
      kma: { analysis: { now: { wet: false } } }
    },
    o: { surfaceCode: 1, precip: 0 },
    wrn: { count: 1, top: { kind: '한파', level: '주의보' } }
  });
  assert.equal(tierDirective.tier, 2);
  assert.equal(tierDirective.cls, 'tier-directive');

  // 3a: Snowing right now (even without flood/ice urgent) -> 빨강 (tier 3)
  const tierSnowNow = classifySeverityTier({
    w: { current: { code: 71, precip: 1.5 }, ice: { rank: 0, decisionCards: [] }, kma: { analysis: { now: { wet: true, type: '눈' } } } },
    o: { surfaceCode: 2, precip: 1.5 },
    wrn: { count: 0 }
  });
  assert.equal(tierSnowNow.tier, 3);
  assert.equal(tierSnowNow.cls, 'tier-danger');

  // 3b: Heavy rain (>=10mm/h) right now -> 빨강 (tier 3)
  const tierHeavyRain = classifySeverityTier({
    w: { current: { code: 65, precip: 14.0 }, ice: { rank: 0, decisionCards: [] }, kma: { analysis: { now: { wet: true, type: '비' } } } },
    o: { surfaceCode: 3, precip: 14.0 },
    wrn: { count: 0 }
  });
  assert.equal(tierHeavyRain.tier, 3);
  assert.equal(tierHeavyRain.cls, 'tier-danger');
});

test('세부 특보구역(함양서북부)은 CAP 폴리곤 좌표 기준으로 함양중부(지곡면)·함양(함양읍)에 오매칭되지 않는다', () => {
  const nwPoly = '35.620,127.550 35.750,127.550 35.750,127.780 35.620,127.780';
  const capMap = new Map([['함양서북부', [nwPoly]]]);
  const wSubZone = { regUpKo: '함양군', regKo: '함양서북부', kind: '한파', level: '주의보' };
  const wWholeCounty = { regUpKo: '함양군', regKo: '함양군', kind: '대설', level: '주의보' };

  // 지곡면(함양중부) & 함양읍은 서북부 폴리곤 외부 -> 세부 구역 미매칭, 군 전체 특보만 매칭
  assert.equal(warningMatchesPlace(wSubZone, '함양중부', 35.566, 127.774, capMap), false);
  assert.equal(warningMatchesPlace(wSubZone, '함양', 35.520, 127.725, capMap), false);
  assert.equal(warningMatchesPlace(wWholeCounty, '함양중부', 35.566, 127.774, capMap), true);
  assert.equal(warningMatchesPlace(wWholeCounty, '함양', 35.520, 127.725, capMap), true);

  // 서상면(35.69, 127.66)은 서북부 폴리곤 내부 -> 매칭됨
  assert.equal(warningMatchesPlace(wSubZone, '함양서북부 테스트', 35.690, 127.660, capMap), true);
});
