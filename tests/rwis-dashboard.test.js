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
  assert.equal(res.short13Summary.freezeCount, 2);
  assert.equal(res.short13Summary.overlapCount, 1);
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
});
