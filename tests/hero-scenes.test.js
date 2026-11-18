const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadHeroModule() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'hero-scenes.js')).href);
}

test('getLunarInfo는 음력 삭(설날)·보름달(정월대보름) 및 직접 달령 오버라이드를 정확히 계산한다', async () => {
  const { getLunarInfo } = await loadHeroModule();

  const newMoon2025 = getLunarInfo(new Date('2025-01-29T21:36:00+09:00'));
  assert.equal(newMoon2025.phaseKey, 'new');
  assert.ok(newMoon2025.illuminationPct <= 2);

  const fullMoon2025 = getLunarInfo(new Date('2025-02-12T22:53:00+09:00'));
  assert.equal(fullMoon2025.phaseKey, 'full');
  assert.ok(fullMoon2025.illuminationPct >= 98);

  const newMoon2026 = getLunarInfo(new Date('2026-02-17T21:01:00+09:00'));
  assert.equal(newMoon2026.phaseKey, 'new');

  const waxing3 = getLunarInfo(new Date(), 3.2);
  assert.equal(waxing3.phaseKey, 'waxing_crescent');
  assert.ok(waxing3.illuminationPct >= 8 && waxing3.illuminationPct <= 15);

  const firstQ = getLunarInfo(new Date(), 7.4);
  assert.equal(firstQ.phaseKey, 'first_quarter');
  assert.ok(firstQ.illuminationPct >= 46 && firstQ.illuminationPct <= 54);

  const thirdQ = getLunarInfo(new Date(), 22.1);
  assert.equal(thirdQ.phaseKey, 'third_quarter');
  assert.ok(thirdQ.illuminationPct >= 46 && thirdQ.illuminationPct <= 54);
});

test('야간 천체 가시성 물리: 맑음(달+별 선명), 구름많음(구름 투과), 비·눈·뇌우·태풍(달·별 비노출)', async () => {
  const { resolveHeroScene } = await loadHeroModule();

  const clearNight = resolveHeroScene({ dayPhase: 'night', weather: 'clear', moonAgeDays: 14.8 });
  assert.equal(clearNight.celestial.moonVisible, true);
  assert.equal(clearNight.celestial.moonOpacity, 1);
  assert.equal(clearNight.celestial.moonThroughCloud, false);
  assert.equal(clearNight.celestial.starOpacity, 1);

  const cloudyNight = resolveHeroScene({ dayPhase: 'night', weather: 'partly_cloudy', moonAgeDays: 14.8 });
  assert.equal(cloudyNight.celestial.moonVisible, true);
  assert.equal(cloudyNight.celestial.moonThroughCloud, true);
  assert.ok(cloudyNight.celestial.starOpacity > 0 && cloudyNight.celestial.starOpacity < 0.6);

  for (const blockedWeather of ['rain', 'snow', 'heavy_snow', 'thunder', 'typhoon']) {
    const blocked = resolveHeroScene({ dayPhase: 'night', weather: blockedWeather, moonAgeDays: 14.8 });
    assert.equal(blocked.celestial.moonVisible, false, `${blockedWeather} 시 야간 달 비노출`);
    assert.equal(blocked.celestial.moonOpacity, 0, `${blockedWeather} 시 달 불투명도 0`);
    assert.equal(blocked.celestial.starOpacity, 0, `${blockedWeather} 시 별 불투명도 0`);
  }
});

test('주야간 시각 추론 및 KMA 수치 코드 → 히어로 장면 자동 매핑 검증', async () => {
  const { resolveDayPhase, inferWeatherFromKma, renderHeroSceneMarkup } = await loadHeroModule();
  const sampleDate = new Date('2026-11-19T00:00:00+09:00');

  assert.equal(resolveDayPhase({ date: sampleDate, hourKst: 7.0 }), 'dawn');
  assert.equal(resolveDayPhase({ date: sampleDate, hourKst: 13.0 }), 'day');
  assert.equal(resolveDayPhase({ date: sampleDate, hourKst: 17.3 }), 'dusk');
  assert.equal(resolveDayPhase({ date: sampleDate, hourKst: 23.0 }), 'night');

  assert.equal(inferWeatherFromKma({ wind: 19, pty: '1' }), 'typhoon');
  assert.equal(inferWeatherFromKma({ lightning: true, pty: '1' }), 'thunder');
  assert.equal(inferWeatherFromKma({ pty: '3', snowAmount: 4 }), 'heavy_snow');
  assert.equal(inferWeatherFromKma({ pty: '3', snowAmount: 1 }), 'snow');
  assert.equal(inferWeatherFromKma({ pty: '1' }), 'rain');
  assert.equal(inferWeatherFromKma({ sky: '3', pty: '0', humidity: 97, wind: 0.6 }), 'fog');
  assert.equal(inferWeatherFromKma({ sky: '4', pty: '0' }), 'overcast');
  assert.equal(inferWeatherFromKma({ sky: '3', pty: '0' }), 'partly_cloudy');
  assert.equal(inferWeatherFromKma({ sky: '1', pty: '0' }), 'clear');

  // 다중 렌더링 시 SVG <defs> ID 충돌이 발생하지 않는지 확인 및 0~3단계 도로 살얼음 색상/태풍 기호 검증
  const first = renderHeroSceneMarkup({ dayPhase: 'night', weather: 'partly_cloudy', moonAgeDays: 14.8, blackIce: true, coldWave: true });
  const second = renderHeroSceneMarkup({ dayPhase: 'night', weather: 'partly_cloudy', moonAgeDays: 14.8, iceRank: 3, coldWave: true });
  assert.equal(first.scene.iceRank, 2);
  assert.equal(first.scene.iceMeta.accent, '#f97316');
  assert.equal(second.scene.iceRank, 3);
  assert.equal(second.scene.iceMeta.accent, '#ef4444');
  assert.ok(second.html.includes('3단계 위험'));
  const rank1 = renderHeroSceneMarkup({ dayPhase: 'day', weather: 'clear', iceRank: 1 });
  assert.equal(rank1.scene.iceMeta.accent, '#eab308');
  assert.ok(rank1.html.includes('1단계 관심'));
  const rank0 = renderHeroSceneMarkup({ dayPhase: 'day', weather: 'clear', iceRank: 0 });
  assert.equal(rank0.scene.iceMeta.accent, '#10b981');
  assert.ok(!rank0.html.includes('hs-road-stage-pill'));

  const ty = renderHeroSceneMarkup({
    dayPhase: 'day',
    weather: 'typhoon',
    typhoonInfo: { no: '제14호', name: '난마돌', pressureHpa: 940, maxWindMs: 47 }
  });
  assert.ok(ty.html.includes('제14호 태풍 난마돌'));
  assert.ok(ty.html.includes('940 hPa'));
  assert.ok(ty.html.includes('hs-typhoon-tag'));
  assert.ok(!ty.html.includes('hs-typhoon-svg'));
  // 화면 전체 끝까지 끊김 없이 이어지는 풀블리드 도로(-20..) + 좌측 그라데이션 페이드 마스크 확인
  assert.ok(ty.html.includes('roadMask'));
  assert.ok(ty.html.includes('M-20,'));

  const idsA = [...first.html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const idsB = [...second.html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.ok(idsA.length > 0 && idsB.length > 0);
  const overlap = idsA.filter(id => idsB.includes(id));
  assert.equal(overlap.length, 0, '다중 장면 렌더링 시 SVG ID가 겹치지 않아야 함');
});
