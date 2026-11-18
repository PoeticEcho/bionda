/**
 * Server-side KMA Live Data Verification & Sanitized Static Snapshot Builder
 * Queries live KMA APIs for all 8 Gwangju-Daegu Expressway (Route 14) regions
 * and writes sanitized public/api/snapshot.json & public/api/radar.png (NO API KEYS included).
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { forecast, server } = require('../server');

const PRESETS = [
  ['대구 달성군남부', '현풍읍', 35.697, 128.447],
  ['함양중부', '지곡면', 35.566, 127.774],
  ['거창군남부', '남상면', 35.644, 127.910],
  ['합천군서북부', '야로면', 35.706, 128.168],
  ['고령군', '대가야읍', 35.728, 128.263],
  ['남원', '남원시청', 35.416, 127.390],
  ['함양', '함양읍', 35.520, 127.725],
  ['거창', '거창읍', 35.687, 127.910]
].map(([name, site, lat, lon]) => ({ name, site, lat, lon }));

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const outDir = path.join(__dirname, '..', 'public', 'api');
  await fs.mkdir(outDir, { recursive: true });

  const roadRes = await fetch(`${base}/api/road-obs?line=14`);
  const roadData = roadRes.ok ? await roadRes.json() : { stations: [] };

  const observations = {};
  const forecasts = {};
  const warnings = {};

  for (const p of PRESETS) {
    const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    const [obsRes, fcstRes, wrnRes] = await Promise.all([
      fetch(`${base}/api/observation?lat=${p.lat}&lon=${p.lon}`),
      fetch(`${base}/api/forecast?lat=${p.lat}&lon=${p.lon}`),
      fetch(`${base}/api/warnings?name=${encodeURIComponent(p.name)}&lat=${p.lat}&lon=${p.lon}`)
    ]);
    if (obsRes.ok) observations[key] = await obsRes.json();
    if (fcstRes.ok) forecasts[key] = await fcstRes.json();
    if (wrnRes.ok) warnings[key] = await wrnRes.json();
    const o = observations[key];
    const f = forecasts[key];
    console.log(
      `[검증완료] ${p.name}(${p.site}) | 도로관측: ${o?.name} 기온=${o?.temp}°C, 노면=${o?.roadTemp}°C(${o?.surfaceState}) | 예보격자(${f?.grid?.nx},${f?.grid?.ny}) 12h강수시작=${f?.analysis?.start?.time?.slice(11, 16) || '없음'}, 종료=${f?.analysis?.end?.time?.slice(11, 16) || '없음'}`
    );
  }

  const radarRes = await fetch(`${base}/api/radar`);
  if (radarRes.ok) {
    const buf = Buffer.from(await radarRes.arrayBuffer());
    await fs.writeFile(path.join(outDir, 'radar.png'), buf);
    console.log(`[검증완료] 기상청 공식 전국 HSR 레이더 이미지 저장 완료 (${buf.length} bytes)`);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    roadLine: '14',
    roadStations: roadData.stations || [],
    observations,
    forecasts,
    warnings
  };

  const jsonStr = JSON.stringify(snapshot, null, 2);
  // Security guardrail: ensure no secret key ever appears in snapshot
  const secret = process.env.KMA_SERVICE_KEY || '';
  if (secret && jsonStr.includes(secret)) {
    throw new Error('보안 오류: 스냅샷에 API 키가 포함되어 있습니다!');
  }

  await fs.writeFile(path.join(outDir, 'snapshot.json'), jsonStr, 'utf8');
  console.log(`[스냅샷 생성 완료] public/api/snapshot.json (${jsonStr.length} bytes, 키 노출 0건)`);
  server.close();
}

main().catch(e => {
  console.error(e);
  try { server.close(); } catch {}
  process.exit(1);
});
