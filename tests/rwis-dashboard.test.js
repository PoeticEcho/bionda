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

test('net-health: API 호출이 30분 이상 누적 실패 시 통합인증 로그인 알림을 띄우고, 복구 시 즉시 해제하며 절전 공백 오알람을 방지한다', async () => {
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

  // 04:10 ~ 04:30 (25분 경과) -> 아직 30분 미만
  for (let m = 5; m <= 25; m += 5) {
    st = recordApiFailure('rwis', 'Failed to fetch', t0 + m * 60000, storage);
  }
  assert.equal(evaluateAuthAlert(st, t0 + 29 * 60000).shouldAlert, false);

  // 04:35 (30분 경과, 연속 7회 실패) -> 중앙 통합인증 로그인 알림 발동!
  st = recordApiFailure('rwis', 'HTTP 502', t0 + 30 * 60000, storage);
  const v30 = evaluateAuthAlert(st, t0 + 30 * 60000);
  assert.equal(v30.shouldAlert, true);
  assert.equal(v30.elapsedMinutes, 30);

  // 10분 스누즈 -> 5분 뒤에는 숨김, 10분 뒤에는 재표출
  snoozeNetHealthAlert(t0 + 30 * 60000, 10 * 60000, storage);
  st = readNetHealthState(storage);
  assert.equal(evaluateAuthAlert(st, t0 + 35 * 60000).shouldAlert, false);
  assert.equal(evaluateAuthAlert(st, t0 + 40 * 60000).shouldAlert, true);

  // 25분 절전 공백 후 재실행 -> 과거 실패 기록으로 오알람 방지
  assert.equal(evaluateAuthAlert(st, t0 + 55 * 60000).shouldAlert, false);

  // 정상 수신 복구 시 즉시 초기화 및 알림 해제
  st = recordApiSuccess('rwis', t0 + 32 * 60000, storage);
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(st.firstFailedAtMs, null);
  assert.equal(evaluateAuthAlert(st, t0 + 32 * 60000).shouldAlert, false);
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
