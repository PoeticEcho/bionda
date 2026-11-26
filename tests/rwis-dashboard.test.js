const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function createMemStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

function parseRings(d) {
  return String(d || '').split('M').slice(1).map(part => {
    const nums = part.match(/-?\d+(?:\.\d+)?/g) || [];
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])]);
    return pts;
  }).filter(r => r.length >= 3);
}

function pointInPoly(px, py, rings) {
  return rings.some(ring => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  });
}

test('net-health: 10분 이상 API 연속 실패 또는 실시간 데이터 미갱신 시 통합인증·인터넷 확인 팝업을 띄우고, 복구 시 즉시 해제한다', async () => {
  const {
    recordApiFailure,
    recordApiSuccess,
    evaluateAuthAlert,
    snoozeNetHealthAlert,
    readNetHealthState
  } = await import('../public/net-health.js');

  const storage = createMemStorage();
  const t0 = Date.parse('2026-11-25T04:05:00+09:00');

  // 04:05 첫 실패 (0분 경과) -> 아직 미표출
  let st = recordApiFailure('rwis', 'Failed to fetch', t0, storage);
  assert.equal(evaluateAuthAlert(st, t0).shouldAlert, false);

  // 04:10 (5분 경과) -> 아직 10분 미만
  st = recordApiFailure('rwis', 'Failed to fetch', t0 + 5 * 60000, storage);
  assert.equal(evaluateAuthAlert(st, t0 + 9 * 60000).shouldAlert, false);

  // 04:15 (10분 경과, 연속 3회 실패) -> 통합인증·인터넷 접속 확인 팝업 발동!
  st = recordApiFailure('rwis', 'HTTP 502', t0 + 10 * 60000, storage);
  const v10 = evaluateAuthAlert(st, t0 + 10 * 60000);
  assert.equal(v10.shouldAlert, true);
  assert.equal(v10.reason, 'api-failure');
  assert.equal(v10.elapsedMinutes, 10);

  // 10분 스누즈 -> 5분 뒤에는 숨김, 10분 뒤에는 재표출
  snoozeNetHealthAlert(t0 + 10 * 60000, 10 * 60000, storage);
  st = readNetHealthState(storage);
  assert.equal(evaluateAuthAlert(st, t0 + 15 * 60000).shouldAlert, false);
  assert.equal(evaluateAuthAlert(st, t0 + 20 * 60000).shouldAlert, true);

  // 25분 절전 공백 후 재실행 -> 과거 실패 기록으로 오알람 방지
  assert.equal(evaluateAuthAlert(st, t0 + 36 * 60000).shouldAlert, false);

  // 정상 수신 복구 시 즉시 초기화 및 알림 해제
  st = recordApiSuccess('rwis', t0 + 12 * 60000, storage);
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(st.firstFailedAtMs, null);
  assert.equal(evaluateAuthAlert(st, t0 + 12 * 60000).shouldAlert, false);

  // 실시간 데이터 미갱신(10분 경과) 감지: 최초 90초 로딩 유예 중에는 숨김, 유예 이후 10분 경과 시 data-stale 팝업!
  const staleCheckBoot = evaluateAuthAlert(st, t0 + 23 * 60000, { sessionStartMs: t0 + 22.5 * 60000 });
  assert.equal(staleCheckBoot.shouldAlert, false);
  const staleCheckLive = evaluateAuthAlert(st, t0 + 23 * 60000, { sessionStartMs: t0 + 12 * 60000 });
  assert.equal(staleCheckLive.shouldAlert, true);
  assert.equal(staleCheckLive.reason, 'data-stale');
  assert.equal(staleCheckLive.elapsedMinutes, 11);
});

test('rwis-data: 4개 광역 지명(전북·경남·경북·대구)과 5개 핵심 시·군 지명(함양군·거창군·합천군·고령군·달성군)이 실제 통계청 경계 폴리곤 내부에 정확히 위치한다', async () => {
  const {
    RWIS_ROUTE_GEO,
    PROVINCE_LABELS_FIXED,
    COUNTY_LABELS
  } = await import('../public/rwis-data.js');

  const provMap = new Map((RWIS_ROUTE_GEO.provinces || []).map(p => [p.name, parseRings(p.d)]));
  const countyMap = new Map((RWIS_ROUTE_GEO.counties || []).map(c => [c.name, parseRings(c.d)]));

  const provFull = {
    전북: '전라북도',
    경남: '경상남도',
    경북: '경상북도',
    대구: '대구광역시'
  };
  for (const [shortName, fullName] of Object.entries(provFull)) {
    const pos = PROVINCE_LABELS_FIXED[shortName];
    assert.ok(pos, `${shortName} 좌표가 정의되어야 함`);
    const rings = provMap.get(fullName);
    assert.ok(rings && rings.length > 0, `${fullName} 폴리곤이 존재해야 함`);
    assert.equal(
      pointInPoly(pos.x, pos.y, rings),
      true,
      `${shortName} (${pos.x}, ${pos.y})는 실제 ${fullName} 경계 폴리곤 내부에 있어야 함`
    );
  }

  const expectedCounties = ['함양군', '거창군', '합천군', '고령군', '달성군'];
  assert.deepEqual(COUNTY_LABELS.map(c => c.name), expectedCounties);
  for (const c of COUNTY_LABELS) {
    const rings = countyMap.get(c.name);
    assert.ok(rings && rings.length > 0, `${c.name} 폴리곤이 존재해야 함`);
    assert.equal(
      pointInPoly(c.x, c.y, rings),
      true,
      `${c.name} (${c.x}, ${c.y})는 실제 ${c.name} 경계 폴리곤 내부에 있어야 함`
    );
  }
});

test('rwis-data: 기존 기상청 도로기상관측·012도로위험·13개소 단기예보를 8개 RWIS 구간에 통합 매핑하고 폴백을 지원한다', async () => {
  const { enrichZonesWithBionda, SHORT13_ROUTE_ORDER } = await import('../public/rwis-data.js');

  const roadStations = [
    { stnId: '14206', name: '함양(도)', milepostKm: 95.0, roadTemp: 3.1, temp: 4.0, surfaceCode: 1, surfaceState: '건조' },
    { stnId: '14409', name: '죽산천교(도)', milepostKm: 102.9, roadTemp: -0.4, temp: 0.8, surfaceCode: 2, surfaceState: '습윤' },
    { stnId: '14410', name: '논공교(도)', milepostKm: 171.3, roadTemp: 1.5, temp: 2.2, surfaceCode: 2, surfaceState: '습윤' }
  ];
  const roadRisk = {
    ok: true,
    stationRisks: {
      '14409': { iceLevel: 3, fogLevel: 1 },
      '14410': { iceLevel: 2, fogLevel: 0 }
    }
  };
  const shortTerm13 = {
    ok: true,
    regions: SHORT13_ROUTE_ORDER.map((id, idx) => ({
      id,
      name: id === 'sudong' ? '수동면' : id === 'okpo' ? '옥포읍' : `읍면${idx}`,
      group: '관내',
      hours: [
        { hourKst: 12, temp: id === 'sudong' ? -1 : 3, wet: id === 'sudong', type: id === 'sudong' ? '눈' : '없음', chance: id === 'sudong' ? 80 : 10 },
        { hourKst: 13, temp: id === 'okpo' ? 0 : 4, wet: false, type: '없음', chance: 10 }
      ]
    }))
  };

  // RWIS 원본 구간이 비어 있어도 기존 012 roadRisk로 8개 구간 위험등급 폴백 구성 확인
  const res = enrichZonesWithBionda({ rwisZones: [], roadStations, roadRisk, shortTerm13 });
  assert.equal(res.zones.length, 8);
  assert.equal(res.coldestRoadStation.stnId, '14409');
  assert.equal(res.coldestRoadStation.roadTemp, -0.4);

  const z170 = res.zones.find(z => z.suffix === '170');
  assert.equal(z170.fsm.max, 3);
  assert.equal(z170.roadObs.minRoadTemp, -0.4);
  assert.equal(z170.roadObs.surfaceState, '습윤');
  assert.equal(z170.shortForecast.hasOverlap, true);

  assert.equal(res.short13Summary.total, 13);
  assert.equal(res.short13Summary.wetCount, 1);
  // P0-2 통일: 엄격 영하(< 0°C)는 sudong(-1°C) 1곳, okpo(0°C)는 firstZeroOrBelow 결빙경계로 구분
  assert.equal(res.short13Summary.freezeCount, 1);
  assert.equal(res.short13Summary.overlapCount, 1);
  const okpo = res.short13List.find(r => r.id === 'okpo');
  assert.equal(okpo.firstFreeze, null);
  assert.equal(okpo.firstZeroOrBelow?.temp, 0);
});

test('3개 메인 대시보드(index·hourly·rwis)가 공통 3탭 네비게이션과 엄격 CSP(인라인 script 없음)를 준수한다', () => {
  const pubDir = path.join(__dirname, '..', 'public');
  for (const fname of ['index.html', 'hourly.html', 'rwis.html']) {
    const html = fs.readFileSync(path.join(pubDir, fname), 'utf8');
    assert.ok(html.includes('href="./index.html"'), `${fname}에 도로기상 상황판 탭이 있어야 함`);
    assert.ok(html.includes('href="./hourly.html"'), `${fname}에 1시간 단기예보 탭이 있어야 함`);
    assert.ok(html.includes('href="./rwis.html"'), `${fname}에 도로살얼음상황판 탭이 있어야 함`);
    // script-src 'self' 준수: 인라인 실행 <script> 태그가 없어야 함
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.equal(inlineScripts.length, 0, `${fname}에 인라인 <script>가 없어야 함`);
  }
  const rwisHtml = fs.readFileSync(path.join(pubDir, 'rwis.html'), 'utf8');
  assert.ok(rwisHtml.includes('data-side-tab="short6" role="tab" aria-selected="true"'), 'rwis.html 우측 기본 탭은 6H 단기예보여야 함');
  assert.ok(rwisHtml.includes('data-side-tab="telemetry"'), '도로관측 탭이 존재해야 함');
  assert.ok(rwisHtml.includes('data-side-tab="cctv"'), '지점·CCTV 탭이 존재해야 함');
  assert.ok(rwisHtml.includes('id="bulletinCards"'), '특이사항 속보 영역이 존재해야 함');
  assert.ok(rwisHtml.includes('id="short6Matrix"'), '6H 13개소 단기예보 표가 존재해야 함');
  assert.ok(rwisHtml.includes('id="rwisReloadBtn"') && rwisHtml.includes('stamp-refresh-ico'), '실시간 상태 배지에 ↻ 새로고침 버튼이 통합되어야 함');
  assert.ok(rwisHtml.includes('id="rwisBurnInBtn"'), '잔상방지 토글 버튼이 존재해야 함');

  // P2 검증: 3개 대시보드 모두 상단 통합 [● 실시간 ↻] 배지 + 다크 상황실 기본 + 관할 이정 롤오버 title 포함
  const indexHtml = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  const hourlyHtml = fs.readFileSync(path.join(pubDir, 'hourly.html'), 'utf8');
  assert.ok(indexHtml.includes('id="reloadAll"') && indexHtml.includes('hdr-stamp-pill'), 'index.html 상단에 통합 실시간 새로고침 배지가 있어야 함');
  assert.ok(hourlyHtml.includes('id="reloadHourlyBtn"') && hourlyHtml.includes('hdr-stamp-pill'), 'hourly.html 상단에 통합 실시간 새로고침 배지가 있어야 함');
  assert.ok(indexHtml.includes('<body class="dark-mode">') && hourlyHtml.includes('class="hourly-page dark-mode"'), 'index/hourly 기본 다크 상황실 테마가 일치해야 함');
  assert.ok(indexHtml.includes('title="고령지사 관할 95~176k'), 'index.html에 관할 이정 롤오버 툴팁이 있어야 함');
  assert.ok(rwisHtml.includes('title="고령지사 관할 95~176k'), 'rwis.html에 관할 이정 롤오버 툴팁이 있어야 함');
});

test('tv-guard: 1px 부드러운 픽셀이동 궤도(어지러움 방지), ON/OFF 저장, 평시 92%/경보 시 100% 휘도 복귀를 검증한다', async () => {
  const {
    PIXEL_ORBIT_STEPS,
    CALM_BRIGHTNESS,
    getOrbitOffset,
    computeTargetBrightness,
    readTvGuardEnabled,
    writeTvGuardEnabled
  } = await import('../public/tv-guard.js');

  assert.ok(PIXEL_ORBIT_STEPS.length >= 30);
  // 모든 스텝이 ±4px 이내이고, 인접 스텝(마지막→첫 스텝 포함) 이동 거리가 정확히 1px (어지러움 방지)
  for (let i = 0; i < PIXEL_ORBIT_STEPS.length; i++) {
    const a = getOrbitOffset(i);
    const b = getOrbitOffset((i + 1) % PIXEL_ORBIT_STEPS.length);
    assert.ok(Math.abs(a.dx) <= 4 && Math.abs(a.dy) <= 4, `step ${i} out of ±4px bounds`);
    const manhattan = Math.abs(a.dx - b.dx) + Math.abs(a.dy - b.dy);
    assert.equal(manhattan, 1, `step ${i}->${i + 1} must shift by exactly 1px (got ${manhattan}px)`);
  }

  // 기본 ON 및 localStorage ON/OFF 영속성
  const mem = new Map();
  const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  assert.equal(readTvGuardEnabled(storage), true);
  writeTvGuardEnabled(false, storage);
  assert.equal(readTvGuardEnabled(storage), false);
  writeTvGuardEnabled(true, storage);
  assert.equal(readTvGuardEnabled(storage), true);

  // 평시 92%, 경보 시 즉시 100%, OFF 시 100%, 모바일 시 100%
  assert.equal(computeTargetBrightness({ enabled: true, isAlert: false, isDesktop: true }), CALM_BRIGHTNESS);
  assert.equal(computeTargetBrightness({ enabled: true, isAlert: true, isDesktop: true }), 1);
  assert.equal(computeTargetBrightness({ enabled: false, isAlert: false, isDesktop: true }), 1);
  assert.equal(computeTargetBrightness({ enabled: true, isAlert: false, isDesktop: false }), 1);
});

test('특이사항 속보: 5개 지역 특보 묶음 규칙(1개=1장, 2개=각각 2장, 3개+=1장 묶음) 및 6시간 특보 해제 감지를 검증한다', async () => {
  const {
    WATCH_WARNING_REGIONS,
    updateWarningHistory,
    buildSpecialBulletinCards
  } = await import('../public/rwis-data.js');

  assert.equal(WATCH_WARNING_REGIONS.length, 5);
  const nowMs = Date.UTC(2026, 10, 25, 3, 0, 0); // 2026-11-25 12:00 KST
  const makeWarnPayload = (regionNames, title = '대설주의보', level = '주의보', tmFc = '202611251030') => {
    const items = {};
    for (const r of WATCH_WARNING_REGIONS) {
      items[`${r.lat.toFixed(3)},${r.lon.toFixed(3)}`] = {
        name: r.name,
        warnings: regionNames.includes(r.name)
          ? [{ title, kind: title.replace(level, ''), level, tmFc, tmEf: '202611251100', announcedText: '11-25 10:30', effectiveText: '11-25 11:00' }]
          : []
      };
    }
    return { ok: true, warningsConfirmed: true, items };
  };

  // 1) 5개 지역 중 1개 지역만 특보 → 1장 단독 카드
  const c1 = buildSpecialBulletinCards({ warningsPayload: makeWarnPayload(['함양군']), nowMs });
  assert.equal(c1.length, 1);
  assert.equal(c1[0].badge, '6h 특보 발표');
  assert.ok(c1[0].title.includes('함양군'));

  // 2) 5개 지역 중 2개 지역 특보 → 각각 1장씩 총 2장 카드
  const c2 = buildSpecialBulletinCards({ warningsPayload: makeWarnPayload(['함양군', '거창군']), nowMs });
  assert.equal(c2.length, 2);
  assert.ok(c2[0].title.includes('함양군'));
  assert.ok(c2[1].title.includes('거창군'));

  // 3) 5개 지역 중 3개 지역 특보 → 1장의 묶음 카드
  const c3 = buildSpecialBulletinCards({ warningsPayload: makeWarnPayload(['함양군', '거창군', '합천군']), nowMs });
  assert.equal(c3.length, 1);
  assert.equal(c3[0].count, 3);
  assert.ok(c3[0].title.includes('3개 지역'));
  assert.ok(c3[0].detail.includes('함양·거창·합천'));

  // 4) 5개 전 지역 특보 → 전 구간 5개 지역 1장 묶음 카드
  const c5 = buildSpecialBulletinCards({
    warningsPayload: makeWarnPayload(['함양군', '거창군', '합천군', '고령군', '달성군']),
    nowMs
  });
  assert.equal(c5.length, 1);
  assert.ok(c5[0].title.includes('전 구간 5개 지역'));

  // 5) 특보 해제 감지: 2개 지역 발효 → 해제 시 각각 2장 해제 카드, 6시간 초과 시 자동 만료
  let hist = updateWarningHistory(null, makeWarnPayload(['함양군', '거창군']), nowMs);
  hist = updateWarningHistory(hist, makeWarnPayload([]), nowMs + 30 * 60 * 1000);
  const lifted2 = buildSpecialBulletinCards({
    warningsPayload: makeWarnPayload([]),
    warningHistory: hist,
    nowMs: nowMs + 60 * 60 * 1000
  });
  assert.equal(lifted2.length, 2);
  assert.equal(lifted2[0].category, 'warning-lifted');
  assert.equal(lifted2[0].badge, '6h 특보 해제');

  const expired = buildSpecialBulletinCards({
    warningsPayload: makeWarnPayload([]),
    warningHistory: hist,
    nowMs: nowMs + 7 * 3600 * 1000
  });
  assert.equal(expired.length, 0);
});

test('특이사항 속보: 6시간 이내 영하/강수/겹침 및 24시간 이내 야간 영하 예고를 유형별로 묶어 표출한다', async () => {
  const { SHORT13_ROUTE_ORDER, buildSpecialBulletinCards, alignShortTerm6hMatrix } = await import('../public/rwis-data.js');

  const makeHours = (temps, wetIdxs = []) => temps.map((t, i) => ({
    time: `2026-11-25T${String((12 + i) % 24).padStart(2, '0')}:00:00+09:00`,
    hourKst: (12 + i) % 24,
    isTomorrow: (12 + i) >= 24,
    temp: t,
    pop: wetIdxs.includes(i) ? 80 : 10,
    wet: wetIdxs.includes(i),
    rainMm: wetIdxs.includes(i) ? 2.5 : 0,
    snowCm: 0,
    pty: wetIdxs.includes(i) ? '1' : '0',
    sky: wetIdxs.includes(i) ? '4' : '1',
    isNight: ((12 + i) % 24) >= 18 || ((12 + i) % 24) < 6
  }));

  // 시나리오 A: 6시간 내에는 맑고 영상, 10시간 뒤(22시) 영하 진입 → 24h 이내 영하 예고 카드 1장
  const nightFreezePayload = {
    ok: true,
    regions: SHORT13_ROUTE_ORDER.map((id, i) => ({
      id,
      name: `지역${i + 1}`,
      county: '함양군',
      admin: '경남',
      color: '#38bdf8',
      windowStart: '2026-11-25T12:00:00+09:00',
      hours: makeHours(i < 4 ? [8, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2] : [8, 8, 7, 6, 5, 4, 3, 2, 2, 1, 1, 1])
    }))
  };
  const mat = alignShortTerm6hMatrix(nightFreezePayload);
  assert.equal(mat.headerHours.length, 6);
  assert.equal(mat.rows.length, 13);

  const cardsNight = buildSpecialBulletinCards({ shortTerm13: nightFreezePayload });
  assert.equal(cardsNight.length, 1);
  assert.equal(cardsNight[0].category, 'freeze-24h');
  assert.equal(cardsNight[0].count, 4);

  // 시나리오 B: 6시간 이내 강수 + 영하 동시 겹침 → 6h 결빙 겹침 + 6h 강수 + 6h 영하 카드
  const urgentPayload = {
    ok: true,
    regions: SHORT13_ROUTE_ORDER.map((id, i) => ({
      id,
      name: `지역${i + 1}`,
      county: '거창군',
      admin: '경남',
      color: '#f59e0b',
      windowStart: '2026-11-25T12:00:00+09:00',
      hours: makeHours(i < 2 ? [2, 1, -1, -2, -2, -1] : [3, 3, 2, 2, 2, 2], i < 2 ? [2, 3] : [])
    }))
  };
  const cardsUrgent = buildSpecialBulletinCards({ shortTerm13: urgentPayload });
  assert.ok(cardsUrgent.some(c => c.category === 'overlap-6h' && c.tone === 'crit'));
  assert.ok(cardsUrgent.some(c => c.category === 'wet-6h'));
  assert.ok(cardsUrgent.some(c => c.category === 'freeze-6h'));
});

test('P1 실측 예비살포 속보 카드 및 #38dbf8 안전 색상 통일을 검증한다', async () => {
  const { evaluateMeasuredPresaltAlerts, buildSpecialBulletinCards } = await import('../public/rwis-data.js');
  const { classifySeverityTier } = await import('../public/ice.js');

  // 1) 평온 건조 상태에서는 예비살포 카드 미발생
  const dryRes = evaluateMeasuredPresaltAlerts({
    roadStations: [
      { stnId: '14206', name: '함양(도)', roadTemp: 11.2, temp: 7.0, surfaceCode: 1, surfaceState: '건조' },
      { stnId: '14407', name: '번암교(도)', roadTemp: 8.0, temp: 5.5, surfaceCode: 1, surfaceState: '건조' }
    ]
  });
  assert.equal(dryRes.corridorHits.length, 0);
  assert.equal(dryRes.westLeadHits.length, 0);

  // 2) 관할(95~176k) 죽산천교 + 서쪽 선행(50~86k) 번암교 실측 예비살포 조건 도달 시 각각 최우선 속보 카드 생성
  const cards = buildSpecialBulletinCards({
    roadStations: [
      { stnId: '14409', name: '죽산천교(도)', roadTemp: 1.4, temp: 3.2, surfaceCode: 2, surfaceState: '습윤' },
      { stnId: '14407', name: '번암교(도)', roadTemp: 0.9, temp: 2.8, surfaceCode: 2, surfaceState: '습윤' }
    ]
  });
  const corCard = cards.find(c => c.category === 'measured-presalt');
  const westCard = cards.find(c => c.category === 'measured-presalt-west');
  assert.ok(corCard, '관할 구간 실측 예비살포 카드가 생성되어야 함');
  assert.ok(corCard.title.includes('죽산천교'));
  assert.ok(westCard, '서쪽 선행구간(50~86k) 예비살포 카드가 생성되어야 함');
  assert.ok(westCard.detail.includes('번암교'));

  // 3) 안전/평온 색상 #38dbf8 통일 검증
  const calmTier = classifySeverityTier({});
  assert.equal(calmTier.pinColor, '#38dbf8');
  const rwisJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'rwis.js'), 'utf8');
  assert.ok(rwisJs.includes("['#38dbf8'"), 'rwis.js LEVEL_COLORS[0]이 #38dbf8이어야 함');
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(stylesCss.includes('.dot-calm { background: #38dbf8; }'), 'styles.css .dot-calm이 #38dbf8이어야 함');
});

test('P2 hourly formatMdHm은 epoch ms 숫자와 ISO 문자열 모두 KST MM-DD HH:MM으로 정확히 포맷한다', async () => {
  const { formatMdHm } = await import('../public/hourly.js');
  // 2026-11-25 17:33 KST === 2026-11-25T08:33:00Z
  const ms = Date.parse('2026-11-25T08:33:00Z');
  assert.equal(formatMdHm(ms), '11-25 17:33');
  assert.equal(formatMdHm(String(ms)), '11-25 17:33');
  assert.equal(formatMdHm('2026-11-25T17:33:00+09:00'), '11-25 17:33');
  assert.equal(formatMdHm('2026-11-25T08:33:00Z'), '11-25 17:33');
});

test('P2.5 6h 실측 + 2h 예측 스파크라인 엔진(슬롯 조립·열관성 예측·인라인 SVG)을 검증한다', async () => {
  const core = await import('../lib/bionda-core.js');
  const { buildZoneTempTrendSeries, renderMicroSparklineSvg, enrichZonesWithBionda } = await import('../public/rwis-data.js');

  // 1) KST 30분 슬롯 생성 및 경량 JSON 조립 검증
  const nowMs = Date.parse('2026-11-25T17:45:00+09:00');
  const slots = core.buildRoadTrendSlots(nowMs, { hours: 6, stepMin: 30 });
  assert.ok(slots.length >= 12 && slots.length <= 13, `6h 30분 슬롯 수는 12~13개여야 함 (got ${slots.length})`);
  assert.equal(slots[slots.length - 1].isLatest, true);
  assert.equal(slots[0].immutable, true);

  const slotResults = slots.map((slot, idx) => ({
    slot,
    stations: [
      { stnId: '14409', name: '죽산천교(도)', milepostKm: 102.9, roadTemp: Number((7.5 - idx * 0.5).toFixed(1)), temp: Number((5.5 - idx * 0.4).toFixed(1)) },
      { stnId: '14206', name: '함양(도)', milepostKm: 95.0, roadTemp: idx === 3 ? null : 10.2, temp: 7.1 }
    ]
  }));
  const payload = core.assembleRoadTrendPayload({ line: '14', hours: 6, stepMin: 30, slotResults, nowMs });
  assert.equal(payload.ok, true);
  assert.equal(payload.times.length, slots.length);
  assert.equal(payload.stations['14409'].tr.length, slots.length);
  assert.equal(payload.stations['14206'].tr[3], null, '결측 센서는 0이 아닌 null로 보존되어야 함');

  // 2) 구간 170(죽산천교) 하강 추세 + 단기예보 강하 ΔTA 결합 → +2h 0°C 진입 감지
  const enriched = enrichZonesWithBionda({
    roadStations: [
      { stnId: '14409', name: '죽산천교(도)', milepostKm: 102.9, roadTemp: 1.5, temp: 0.7, surfaceCode: 1, surfaceState: '건조' }
    ]
  });
  const z170 = enriched.zones.find(z => z.suffix === '170');
  assert.equal(z170.roadObs.stationId, '14409');

  const shortTerm13 = {
    ok: true,
    regions: [
      {
        id: 'sudong',
        hours: [
          { time: '2026-11-25T17:00:00+09:00', temp: 1 },
          { time: '2026-11-25T18:00:00+09:00', temp: 0 },
          { time: '2026-11-25T19:00:00+09:00', temp: -1 }
        ]
      }
    ]
  };
  const series = buildZoneTempTrendSeries({ zone: z170, roadTrend: payload, shortTerm13, nowMs });
  assert.equal(series.tr.curVal, 1.5, '실황 표시 노면온도와 스파크라인 현재점이 일치해야 함');
  assert.ok(series.tr.delta6h < -5, '6시간 누적 하강폭이 반영되어야 함');
  assert.ok(series.tr.pred2h < series.tr.curVal, '하강 추세+기온 강하 시 +2h 노면 예측이 하락해야 함');
  assert.ok(series.tr.pred2h <= 0.2, `+2h 노면온도가 0°C 부근까지 하강해야 함 (got ${series.tr.pred2h})`);
  assert.equal(series.ta.pred2h, -1.3, '기온 +2h는 실측(0.7) + 예보 ΔTA(-2) = -1.3°C');
  assert.equal(series.ta.crossesZeroSoon, true);

  // 3) 인라인 SVG 스파크라인 렌더링 검증 (실선·점선·현재점·0° 기준선·위험색 에스컬레이션)
  const svgRoad = renderMicroSparklineSvg(series.tr, { kind: 'road', uid: 'z170-tr' });
  assert.ok(svgRoad.includes('sp-obs'), '6h 실측 실선 포함');
  assert.ok(svgRoad.includes('sp-pred'), '+2h 점선 예측 포함');
  assert.ok(svgRoad.includes('sp-now'), '현재 시점 앵커 점 포함');
  assert.ok(svgRoad.includes('0°'), '결빙 근접 시 0° 기준선 표시');
  assert.ok(svgRoad.includes('#fb7185'), '+2h 0.5°C 이하 진입 시 위험 로즈 색상 적용');

  // 4) 데이터 미수신 시에도 카드 높이가 흔들리지 않는 빈 플레이스홀더 SVG 반환
  const emptySvg = renderMicroSparklineSvg({ obs: [], pred: [] }, { kind: 'road', uid: 'empty' });
  assert.ok(emptySvg.includes('is-empty') && emptySvg.includes('viewBox="0 0 122 28"'));

  // 5) 교량 결빙관측소(14409 죽산천교)에 기온(TA)이 전부 null이어도 같은 구간의 남상졸음(14207) 기온 6h 시계열로 자동 보완
  const bridgeTrend = {
    ok: true,
    hours: 6,
    times: payload.times,
    stations: {
      '14409': { name: '죽산천교(도)', km: 102.9, tr: payload.stations['14409'].tr, ta: payload.times.map(() => null) },
      '14207': { name: '남상졸음(도)', km: 115.3, tr: payload.stations['14409'].tr, ta: payload.times.map((_, i) => Number((6.0 - i * 0.25).toFixed(1))) }
    }
  };
  const bridgeSeries = buildZoneTempTrendSeries({ zone: z170, roadTrend: bridgeTrend, shortTerm13, nowMs });
  assert.equal(bridgeSeries.stationName, '죽산천교(도)');
  assert.equal(bridgeSeries.airStationName, '남상졸음(도)');
  assert.ok(bridgeSeries.ta.obs.length >= 10, '교량 TA 결측 시 동일 구간 기온 관측소 6h 추세로 자동 보완되어야 함');

  // 6) 일출/주간 상승 반전 검증: 과거 2h 노면이 하강했더라도 다음 2h 기온이 상승(+0.5, +1.5°C)하면 +2h 예측이 상승 기울기로 전환
  const sunriseShort13 = {
    ok: true,
    regions: [
      {
        id: 'sudong',
        hours: [
          { time: '2026-11-25T17:00:00+09:00', temp: 1 },
          { time: '2026-11-25T18:00:00+09:00', temp: 2 },
          { time: '2026-11-25T19:00:00+09:00', temp: 3 }
        ]
      }
    ]
  };
  const sunriseSeries = buildZoneTempTrendSeries({ zone: z170, roadTrend: payload, shortTerm13: sunriseShort13, nowMs });
  assert.ok(sunriseSeries.ta.pred2h > sunriseSeries.ta.curVal, '다음 2h 기온 상승 시 기온 예측은 상승 기울기여야 함');
  assert.ok(sunriseSeries.tr.pred2h > sunriseSeries.tr.curVal, '일출 상승 반전 시 노면 예측도 상승 기울기로 전환되어야 함');
});

test('P3 모듈 분리(snow-directive·minimap), 1시간 단기예보 24h 기본, 라이트모드 선명도를 검증한다', async () => {
  const { createSnowDirectiveStore, formatKstClock, parseKstHhmmToMs, getActionSignature } = await import('../public/snow-directive.js');
  const { resolveStationKm } = await import('../public/minimap.js');

  // 1) snow-directive.js 독립 동작 검증 (살포시각·특보해제·ACK 시그니처)
  const mem = new Map();
  const mockStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v))
  };
  const store = createSnowDirectiveStore({ storage: mockStorage });
  const place = { name: '거창군남부', lat: 35.644, lon: 127.910 };
  const nowMs = Date.parse('2026-11-25T08:00:00+09:00');
  assert.equal(formatKstClock(nowMs), '08:00');
  const parsedYesterday = parseKstHhmmToMs('23:30', nowMs);
  assert.ok(parsedYesterday < nowMs && (nowMs - parsedYesterday) === 8.5 * 3600000, '자정 이전 입력 시각은 전일로 해석');

  store.setSpreadTime(place, 'presalt', nowMs - 3600000);
  assert.equal(store.getSpreadEntry(place, 'presalt', nowMs)?.atMs, nowMs - 3600000);
  store.clearSpreadTime(place, 'presalt');
  assert.equal(store.getSpreadEntry(place, 'presalt', nowMs), null);

  store.syncSnowWarningHistory(place, { raw: [{ title: '대설주의보', kind: '대설' }] }, nowMs - 1800000);
  store.syncSnowWarningHistory(place, { raw: [] }, nowMs);
  assert.equal(store.getSnowWarningClearedState(place, { raw: [] }, nowMs + 60000).recentlyCleared, true);

  const cards = [{ stageId: 'presalt', state: 'watch', pcChip: '예비살포 2h전' }];
  assert.equal(getActionSignature(cards), 'presalt:watch:예비살포 2h전');
  store.acknowledgeActionCards(place, cards);
  assert.equal(store.getUnackedActionCards(place, { w: { ice: { decisionCards: cards } } }, nowMs).length, 0);
  const escalated = [{ stageId: 'presalt', state: 'urgent', pcChip: '예비살포 즉시' }];
  assert.equal(store.getUnackedActionCards(place, { w: { ice: { decisionCards: escalated } } }, nowMs).length, 1, '위험 격상 시 확인 숨김이 자동 해제되어야 함');

  // 2) minimap.js 이정 해석 검증
  assert.equal(resolveStationKm({ name: '죽산천교(도)' }), 102.9);
  assert.equal(resolveStationKm({ name: '커스텀', milepostKm: 134.1 }), 134.1);

  // 3) 1시간 단기예보 24시간 기본 & 라이트모드 선명도 검증
  const hourlyHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'hourly.html'), 'utf8');
  const hourlyJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'hourly.js'), 'utf8');
  const themeCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme.css'), 'utf8');
  assert.ok(hourlyHtml.includes('class="hr-tbtn active" data-range="24"'), 'hourly.html 기본 활성 탭은 24시간이어야 함');
  assert.ok(hourlyJs.includes("range: '24'"), 'hourly.js state.range 기본값은 24여야 함');
  assert.ok(themeCss.includes('--ink: #0b1e21') && themeCss.includes('--muted: #2d494e'), '라이트모드 고대비 글자 토큰이 반영되어야 함');
  const { computeTargetBrightness } = await import('../public/tv-guard.js');
  assert.equal(computeTargetBrightness({ enabled: true, isAlert: false, isDesktop: true, isLightMode: true }), 1, '라이트모드에서는 회색 음영(brightness 0.92)을 씌우지 않아야 함');
  assert.equal(computeTargetBrightness({ enabled: true, isAlert: false, isDesktop: true, isLightMode: false }), 0.92);
});

test('도로살얼음상황판 최종 고도화: 7개 RWIS 콜아웃(습도 조건부 괄호)·구간 기준관측소·13개지역 지도 오버레이 토글을 검증한다', async () => {
  const {
    CORRIDOR_MAP_STATIONS,
    SHORT13_MAP_LOCATIONS,
    SHORT13_ROUTE_ORDER,
    formatStationBasisLabel,
    formatRwisCalloutLines
  } = await import('../public/rwis-data.js');

  // 1) 습도가 있는 일반 관측소: '함양(95k)' / '3.0°' / '노면 5.1° - 건조 (72%)'
  const stnHamyang = CORRIDOR_MAP_STATIONS.find(s => s.stnId === '14206');
  const hamLines = formatRwisCalloutLines(stnHamyang, { temp: 3.0, roadTemp: 5.1, humidity: 71.6, surfaceState: '건조' });
  assert.equal(hamLines.titleLeft, '함양(95k)');
  assert.equal(hamLines.titleRight, '3.0°');
  assert.equal(hamLines.subLine, '노면 5.1° - 건조 (72%)');

  // 2) 습도가 없는 교량 결빙관측소: 괄호 완전 생략 ('노면 4.3° - 건조')
  const stnJuksan = CORRIDOR_MAP_STATIONS.find(s => s.stnId === '14409');
  const jukLines = formatRwisCalloutLines(stnJuksan, { temp: null, roadTemp: 4.3, humidity: null, surfaceState: '건조' });
  assert.equal(jukLines.titleLeft, '죽산천교(103k)');
  assert.equal(jukLines.titleRight, '교량');
  assert.equal(jukLines.subLine, '노면 4.3° - 건조');
  assert.ok(!jukLines.subLine.includes('('), '습도 결측 시 괄호가 표시되면 안 됨');

  // 3) 구간 카드 기준 관측소 표기 ('함양(도) 기준' vs '죽산천교 기준')
  assert.equal(formatStationBasisLabel('함양(도)'), '함양(도) 기준');
  assert.equal(formatStationBasisLabel('죽산천교(도)'), '죽산천교 기준');
  assert.equal(formatStationBasisLabel('양전교(도)'), '양전교 기준');

  // 4) 13개 단기예보 지도 위치가 SHORT13_ROUTE_ORDER 13개소와 1:1 일치
  assert.equal(SHORT13_MAP_LOCATIONS.length, 13);
  assert.deepEqual(
    SHORT13_MAP_LOCATIONS.map(x => x.id).sort(),
    [...SHORT13_ROUTE_ORDER].sort()
  );

  // 5) rwis.html 상단 툴바 [노면온도][13개지역][지도 크게] 순서 검증
  const rwisHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'rwis.html'), 'utf8');
  const idxRoad = rwisHtml.indexOf('id="toggleRoadTempOverlay"');
  const idxS13 = rwisHtml.indexOf('id="toggleShort13Overlay"');
  const idxBig = rwisHtml.indexOf('id="toggleMapBigBtn"');
  assert.ok(idxRoad > 0 && idxS13 > idxRoad && idxBig > idxS13, '[노면온도][13개지역][지도 크게] 순서로 배치되어야 함');

  // 6) RWIS 7개 카드 대각 균형 도킹 배치 (상단좌측 2 · 하단중앙 2 · 상단 1 · 하단우측 2) 검증
  const dockByShort = Object.fromEntries(CORRIDOR_MAP_STATIONS.map(s => [s.shortName, s.dock]));
  assert.equal(dockByShort['함양'].row, 'top');
  assert.equal(dockByShort['죽산천교'].row, 'top');
  assert.ok(dockByShort['함양'].cx < dockByShort['죽산천교'].cx && dockByShort['죽산천교'].cx < 500, '함양·죽산천교는 상단 좌측 나란히 배치되어야 함');
  assert.equal(dockByShort['남상졸음'].row, 'bottom');
  assert.equal(dockByShort['거창휴'].row, 'bottom');
  assert.ok(dockByShort['남상졸음'].cx < dockByShort['거창휴'].cx, '남상졸음·거창휴는 하단 나란히 배치되어야 함');
  assert.equal(dockByShort['양전교'].row, 'top');
  assert.equal(dockByShort['논공휴'].row, 'bottom');
  assert.equal(dockByShort['논공교'].row, 'bottom');
  assert.ok(dockByShort['논공휴'].cx < dockByShort['논공교'].cx && dockByShort['논공휴'].cx > 1050, '논공휴·논공교는 하단 우측 나란히 배치되어야 함');

  // 7) SVG 레이어 Z-순서: 지시선(map-leader-underlay)이 노선·시군·13개지역·IC·RWIS 카드보다 하위 레이어로 먼저 그려지는지 검증
  const rwisJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'rwis.js'), 'utf8');
  const idxUnderlay = rwisJs.indexOf('class="map-leader-underlay"');
  const idxCorridor = rwisJs.indexOf('class="corridor-zones"');
  const idxCounty = rwisJs.indexOf('class="county-labels"');
  const idxS13Pins = rwisJs.indexOf('class="short13-map-pins"');
  const idxNodes = rwisJs.indexOf('class="route-nodes"');
  const idxRwisCards = rwisJs.indexOf('class="road-temp-pins"');
  assert.ok(
    idxUnderlay > 0 &&
    idxUnderlay < idxCorridor &&
    idxCorridor < idxCounty &&
    idxCounty < idxS13Pins &&
    idxS13Pins < idxNodes &&
    idxNodes < idxRwisCards,
    '지시선 레이어는 노선 및 모든 라벨·배지·카드 아래에 위치해야 함'
  );
  assert.ok(rwisJs.includes('renderKmaIconSvg(iconInfo, 26)'), '13개 지역 배지는 TV용 26px 대형 아이콘을 사용해야 함');
});

test('한국도로공사 도로살얼음 위험정보 대응방법 변경알림(주의·위험 격상 팝업 문구·점멸·고정식 기상정보·중복알림 방지) 및 결측/안전 분리를 검증한다', async () => {
  const {
    evaluateBranchIceEscalations,
    normalizeIceGrade
  } = await import('../public/ice-alert-modal.js');
  const {
    indexStationRisks,
    enrichZonesWithBionda,
    buildSpecialBulletinCards
  } = await import('../public/rwis-data.js');

  assert.equal(normalizeIceGrade(0), 0);
  assert.equal(normalizeIceGrade('2'), 2);
  assert.equal(normalizeIceGrade(null), null);
  assert.equal(normalizeIceGrade(-999), null);

  // 1) stationRisks 배열(실서버 응답 형태) 정규화 및 결측 시 '정보 없음'(No False Safety) 검증
  const emptyEnriched = enrichZonesWithBionda({ rwisZones: [], roadStations: [], roadRisk: null });
  assert.equal(emptyEnriched.zones[0].fsm.missing, true);
  assert.equal(emptyEnriched.zones[0].fsm.rawMax, null);
  assert.equal(emptyEnriched.zones[0].fsm.statusLabel, '정보 없음');

  const arrayRoadRisk = {
    ok: true,
    tmKst: '2026-11-26T00:05:00+09:00',
    stationRisks: [
      { stnId: '14209', name: '양전교(도)', iceLevel: 2, fogLevel: 0 },
      { stnId: '14407', name: '번암교(도)', iceLevel: 3, fogLevel: 0 } // 서쪽 관할외(72.9k)
    ]
  };
  const idxMap = indexStationRisks(arrayRoadRisk);
  assert.equal(idxMap.get('14209')?.iceLevel, 2);

  const enrichedFromArray = enrichZonesWithBionda({
    rwisZones: [],
    roadStations: [{ stnId: '14209', name: '양전교(도)', roadTemp: 1.3, temp: 2.8, surfaceCode: 2, surfaceState: '습윤' }],
    roadRisk: arrayRoadRisk
  });
  const z210 = enrichedFromArray.zones.find(z => z.suffix === '210'); // 고령IC-동고령IC (양전교)
  const z160 = enrichedFromArray.zones.find(z => z.suffix === '160'); // 함양IC-함양JC (미수신)
  assert.equal(z210.fsm.rawMax, 2);
  assert.equal(z210.fsm.missing, false);
  assert.equal(z210.fsm.statusLabel, '주의');
  assert.equal(z160.fsm.missing, true);
  assert.equal(z160.fsm.statusLabel, '정보 없음');

  // 2) 특이사항 속보 최우선(priority 1~2) KEC 격상 카드 생성 검증
  const bCards = buildSpecialBulletinCards({
    roadStations: [{ stnId: '14209', name: '양전교(도)', roadTemp: 1.3, temp: 2.8, surfaceCode: 2, surfaceState: '습윤' }],
    roadRisk: arrayRoadRisk,
    enrichedZones: enrichedFromArray.zones
  });
  assert.equal(bCards[0].category, 'kec-ice-escalation');
  assert.ok(bCards[0].title.includes('도로살얼음 위험정보 주의 격상'));

  // 3) KEC 공식 팝업 판정 순수 함수: 평시(0단계) -> 주의(2단계) 격상 -> 확인(Ack) -> 위험(3단계) 재격상 -> 해제(0단계) -> 재격상
  const roadStations = [
    { stnId: '14209', name: '양전교(도)', roadTemp: 1.2, temp: 2.6, surfaceCode: 2, surfaceState: '습윤' },
    { stnId: '14103', name: '논공휴(도)', roadTemp: 6.5, temp: 5.8, surfaceCode: 2, surfaceState: '습윤' } // 영상(>4°C, >2°C) 습윤 오탐 점검 케이스
  ];
  const nowMs = Date.parse('2026-11-26T00:05:00+09:00');

  // Step A: 초기 전 구간 안전(0단계) + 관할외(inBranch:false) 위험(3단계) -> 팝업 미발생!
  const step0 = evaluateBranchIceEscalations({
    prevLevels: {},
    ackMap: {},
    initialized: false,
    items: [
      { id: 'zone:210', label: '고령IC ↔ 동고령IC', kmLabel: '152.9~165.5k', inBranch: true, iceLevel: 0, stnIds: ['14209'] },
      { id: 'zone:230', label: '고령JC ↔ 옥포JC', kmLabel: '167.0~176.0k', inBranch: true, iceLevel: 0, stnIds: ['14103'] },
      { id: 'stn:14407', label: '번암교', kmLabel: '72.9k', inBranch: false, iceLevel: 3, stnIds: ['14407'] }
    ],
    roadStations,
    tmKst: '2026-11-26T00:00:00+09:00',
    nowMs
  });
  assert.equal(step0.shouldPopup, false);
  assert.equal(step0.activeAlertIds.length, 0);

  // Step B: 5분 뒤 고령IC↔동고령IC(저온 습윤) + 고령JC↔옥포JC(영상 습윤) 주의(2단계) 격상!
  const stepCaution = evaluateBranchIceEscalations({
    prevLevels: step0.nextLevels,
    ackMap: step0.nextAckMap,
    initialized: step0.initialized,
    items: [
      { id: 'zone:210', label: '고령IC ↔ 동고령IC', kmLabel: '152.9~165.5k', inBranch: true, iceLevel: 2, stnIds: ['14209'] },
      { id: 'zone:230', label: '고령JC ↔ 옥포JC', kmLabel: '167.0~176.0k', inBranch: true, iceLevel: 2, stnIds: ['14103'] }
    ],
    roadStations,
    tmKst: '2026-11-26T00:05:00+09:00',
    nowMs
  });
  assert.equal(stepCaution.shouldPopup, true);
  assert.equal(stepCaution.popupLevel, 2);
  assert.equal(stepCaution.refTimeText, '2026-11-26 00:05');
  assert.equal(stepCaution.headline, '도로살얼음 위험정보 주의 격상 알림');
  assert.equal(stepCaution.directive, '온도, 노면상태 확인 후 예비살포');
  assert.deepEqual(stepCaution.activeAlertIds, ['zone:210', 'zone:230']);
  // 저온 구간(양전교 1.2°C) vs 영상 습윤 구간(논공휴 6.5°C) 안내 문구 구분 확인
  const hitCold = stepCaution.triggeredItems.find(x => x.id === 'zone:210');
  const hitWarm = stepCaution.triggeredItems.find(x => x.id === 'zone:230');
  assert.equal(hitCold.isColdCondition, true);
  assert.ok(hitWarm.tempCheckNote.includes('습윤 오탐'));

  // Step C: 사용자가 [확인] 클릭 후 다음 5분 주기에 동일 주의(2단계) 유지 -> 팝업 재표출 안 함, 점멸(activeAlertIds)은 유지!
  const acked = {
    'zone:210': { level: 2, atMs: nowMs },
    'zone:230': { level: 2, atMs: nowMs }
  };
  const stepSteady = evaluateBranchIceEscalations({
    prevLevels: stepCaution.nextLevels,
    ackMap: acked,
    initialized: true,
    items: [
      { id: 'zone:210', label: '고령IC ↔ 동고령IC', kmLabel: '152.9~165.5k', inBranch: true, iceLevel: 2, stnIds: ['14209'] },
      { id: 'zone:230', label: '고령JC ↔ 옥포JC', kmLabel: '167.0~176.0k', inBranch: true, iceLevel: 2, stnIds: ['14103'] }
    ],
    roadStations,
    tmKst: '2026-11-26T00:10:00+09:00',
    nowMs: nowMs + 5 * 60000
  });
  assert.equal(stepSteady.shouldPopup, false);
  assert.deepEqual(stepSteady.activeAlertIds, ['zone:210', 'zone:230']);

  // Step D: 주의(2단계) -> 위험(3단계) 추가 격상 시 즉시 위험 팝업 재발동!
  const stepDanger = evaluateBranchIceEscalations({
    prevLevels: stepSteady.nextLevels,
    ackMap: stepSteady.nextAckMap,
    initialized: true,
    items: [
      { id: 'zone:210', label: '고령IC ↔ 동고령IC', kmLabel: '152.9~165.5k', inBranch: true, iceLevel: 3, stnIds: ['14209'] },
      { id: 'zone:230', label: '고령JC ↔ 옥포JC', kmLabel: '167.0~176.0k', inBranch: true, iceLevel: 2, stnIds: ['14103'] }
    ],
    roadStations,
    tmKst: '2026-11-26T00:15:00+09:00',
    nowMs: nowMs + 10 * 60000
  });
  assert.equal(stepDanger.shouldPopup, true);
  assert.equal(stepDanger.popupLevel, 3);
  assert.equal(stepDanger.headline, '도로살얼음 위험정보 위험 격상 알림');
  assert.equal(stepDanger.directive, '예비살포 실시');
  assert.ok(stepDanger.subDirective.includes('선(先)예비살포, 후(後)상황판단회의'));

  // Step E: 안전(0단계) 해제 시 Ack 기록 자동 초기화 -> 이후 다시 주의(2단계) 발생 시 정상 재알림!
  const stepClear = evaluateBranchIceEscalations({
    prevLevels: stepDanger.nextLevels,
    ackMap: { 'zone:210': { level: 3, atMs: nowMs + 10 * 60000 } },
    initialized: true,
    items: [
      { id: 'zone:210', label: '고령IC ↔ 동고령IC', kmLabel: '152.9~165.5k', inBranch: true, iceLevel: 0, stnIds: ['14209'] }
    ],
    roadStations,
    tmKst: '2026-11-26T00:20:00+09:00',
    nowMs: nowMs + 15 * 60000
  });
  assert.equal(stepClear.shouldPopup, false);
  assert.equal(stepClear.nextAckMap['zone:210'], undefined);
});
