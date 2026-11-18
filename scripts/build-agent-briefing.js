/**
 * AI 에이전트(그록·피클 등)용 메인 1:1 정방형 브리핑 JPG(08시·18시, 3일 보관) 및 경량 요약 briefing.json 생성기
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { server } = require('../server');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BRIEFING_DIR = path.join(PUBLIC_DIR, 'api', 'briefing');
const BRIEFING_JSON_PATH = path.join(PUBLIC_DIR, 'api', 'briefing.json');

const MILEPOST_KM = {
  '남원': 55.5,
  '함양': 93.5,
  '함양중부': 99.2,
  '거창군남부': 115.9,
  '거창': 120.5,
  '합천군서북부': 145.5,
  '고령군': 154.6,
  '대구 달성군남부': 171.6
};

const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatKstDate(ms) {
  const k = new Date(ms + 9 * 3600000);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`;
}

function formatKstStamp(ms) {
  const k = new Date(ms + 9 * 3600000);
  return `${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`;
}

function resolveBriefingSlot(nowMs = Date.now(), forcedSlot = '') {
  const kst = new Date(nowMs + 9 * 3600000);
  const hour = kst.getUTCHours();

  if (forcedSlot === '0800' || forcedSlot === '1800') {
    const dateStr = formatKstDate(nowMs);
    return {
      slot: `${dateStr}-${forcedSlot}`,
      slotCode: forcedSlot,
      slotDate: dateStr,
      slotLabelKst: `${dateStr} ${forcedSlot.slice(0, 2)}:00 KST`,
      filename: `goryeong-${dateStr}-${forcedSlot}.jpg`
    };
  }

  let slotDate = formatKstDate(nowMs);
  let slotCode = '1800';
  if (hour >= 5 && hour < 15) {
    slotCode = '0800';
  } else if (hour < 5) {
    slotDate = formatKstDate(nowMs - 24 * 3600000);
    slotCode = '1800';
  }
  const slot = `${slotDate}-${slotCode}`;
  return {
    slot,
    slotCode,
    slotDate,
    slotLabelKst: `${slotDate} ${slotCode.slice(0, 2)}:00 KST`,
    filename: `goryeong-${slot}.jpg`
  };
}

function parseSlotMs(slotStr) {
  const m = String(slotStr).match(/^(\d{4})-(\d{2})-(\d{2})-(0800|1800)$/);
  if (!m) return null;
  const [, y, mo, d, code] = m;
  const hh = Number(code.slice(0, 2));
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hh, 0, 0) - 9 * 3600000;
}

function pruneOldBriefingFiles(briefingDir, referenceSlot, maxDays = 3, maxSlots = 6) {
  if (!fs.existsSync(briefingDir)) return { kept: [], deleted: [] };
  const refMs = parseSlotMs(referenceSlot) ?? Date.now();
  const maxAgeMs = maxDays * 24 * 3600000;
  const parsed = [];

  for (const name of fs.readdirSync(briefingDir)) {
    const m = name.match(/^goryeong-(\d{4}-\d{2}-\d{2}-(?:0800|1800))\.jpg$/);
    if (!m) continue;
    const slot = m[1];
    const ms = parseSlotMs(slot);
    if (!Number.isFinite(ms)) continue;
    const fullPath = path.join(briefingDir, name);
    parsed.push({ name, slot, ms, fullPath, size: fs.statSync(fullPath).size });
  }

  parsed.sort((a, b) => b.ms - a.ms);
  const kept = [];
  const deleted = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    const tooOld = refMs - item.ms > maxAgeMs;
    const overSlotCap = i >= maxSlots;
    if (tooOld || overSlotCap) {
      fs.unlinkSync(item.fullPath);
      deleted.push(item.name);
    } else {
      kept.push(item);
    }
  }
  return { kept, deleted };
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
      if (resolved) return resolved;
    } catch {}
  }
  throw new Error('헤드리스 Chrome/Chromium 바이너리를 찾을 수 없습니다.');
}

async function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const onMsg = ev => {
      const d = JSON.parse(ev.data);
      if (d.id === id) {
        ws.removeEventListener('message', onMsg);
        if (d.error) reject(new Error(d.error.message));
        else resolve(d.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const slotArgIdx = args.indexOf('--slot');
  const forcedSlot = slotArgIdx >= 0 ? (args[slotArgIdx + 1] || '') : (process.env.BRIEFING_SLOT || '');
  const qualityArgIdx = args.indexOf('--quality');
  const jpgQuality = qualityArgIdx >= 0 ? Math.max(0.4, Math.min(0.95, Number(args[qualityArgIdx + 1]))) : 0.72;

  const slotInfo = resolveBriefingSlot(Date.now(), forcedSlot);
  fs.mkdirSync(BRIEFING_DIR, { recursive: true });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const chromeBin = findChromeBinary();

  const debugPort = 9379;
  const profDir = path.join(require('node:os').tmpdir(), 'bionda_brief_' + Date.now());
  const chromeProc = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `${baseUrl}/#overview`
  ]);

  let wsUrl = null;
  for (let i = 0; i < 35; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find(x => x.type === 'page');
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
  }
  if (!wsUrl) throw new Error('Chrome CDP 연결 실패');

  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r));
  await cdpSend(ws, 'Runtime.enable');

  // Wait for weather & observation data load (max ~7s)
  await sleep(4500);
  await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const app = await import('./app.js');
      for (let i = 0; i < 25; i++) {
        const ready = app.presets.every(p => {
          const r = app.record(p);
          return r && r.w && r.w.rows && r.w.rows.length;
        });
        if (ready) break;
        await new Promise(r => setTimeout(r, 250));
      }
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  const stampStr = formatKstStamp(Date.now());
  const result = await cdpSend(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const app = await import('./app.js');
      const share = await import('./share.js');
      const iceMod = await import('./ice.js');

      const sorted = [...app.presets].sort((a, b) => {
        const ta = iceMod.classifySeverityTier(app.record(a)).tier;
        const tb = iceMod.classifySeverityTier(app.record(b)).tier;
        return tb - ta;
      });
      const canvas = share.renderOverviewCanvas(sorted, app.record, ${JSON.stringify(stampStr)}, app.summary);
      const blob = await share.canvasToJpgBlob(canvas, ${jpgQuality});
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const jpgB64 = btoa(bin);

      const regions = app.presets.map(p => {
        const r = app.record(p);
        const w = r.w, o = r.o, wrn = r.wrn;
        const sev = iceMod.classifySeverityTier(r);
        const timing = app.rainTimingSummary(w, o);
        const tempC = o?.temp ?? w?.current?.temp ?? null;
        const ranges = w?.kma?.analysis?.horizonRanges || [];
        return {
          name: p.name,
          site: p.site,
          lat: p.lat,
          lon: p.lon,
          tier: sev.tier,
          tierLabel: sev.label,
          tempC: Number.isFinite(tempC) ? Number(tempC.toFixed(1)) : null,
          roadTempC: Number.isFinite(o?.roadTemp) ? Number(o.roadTemp.toFixed(1)) : null,
          surfaceState: o?.surfaceState || null,
          roadStation: o?.roadStationName || null,
          condition: o?.description || app.summary(w?.current?.code),
          humidityPct: o?.humidity ?? w?.current?.humidity ?? null,
          todayPrecipMm: o?.dayPrecip ?? w?.today?.precip ?? 0,
          maxPop6hPct: w?.rows?.length ? Math.max(...w.rows.map(x => Number.isFinite(x.pop) ? x.pop : 0)) : 0,
          rainTiming: timing.mainText.replace(/^[☔❄️◇☀]\\s*/, ''),
          horizons: ranges.map(hr => ({
            window: hr.label,
            status: hr.hasPrecipitation ? ((hr.kinds || []).join('·') || '강수') + ' 예상' : hr.hasRisk ? '강수 가능성' : '신호 없음'
          })),
          ice: {
            level: w?.ice?.level || '확인중',
            rank: w?.ice?.rank || 0,
            shortReason: w?.ice?.shortReason || ''
          },
          warnings: (wrn?.tooltipLines || []).map(wl => ({
            title: wl.title,
            area: wl.areaName || '',
            effective: wl.effectiveLabel,
            expires: wl.expiresLabel
          }))
        };
      });

      return { jpgB64, regions };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error('브라우저 브리핑 렌더링 오류: ' + JSON.stringify(result.exceptionDetails));
  }

  const { jpgB64, regions } = result.result.value;
  const jpgBuf = Buffer.from(jpgB64, 'base64');
  const slotPath = path.join(BRIEFING_DIR, slotInfo.filename);
  const latestPath = path.join(BRIEFING_DIR, 'latest.jpg');

  fs.writeFileSync(slotPath, jpgBuf);
  fs.writeFileSync(latestPath, jpgBuf);

  const { kept, deleted } = pruneOldBriefingFiles(BRIEFING_DIR, slotInfo.slot, 3, 6);

  const enrichRegions = regions.map(reg => ({
    ...reg,
    milepostKm: MILEPOST_KM[reg.name] ?? null
  }));

  const tierCounts = { danger: 0, directive: 0, watch: 0, calm: 0 };
  for (const reg of enrichRegions) {
    if (reg.tier === 3) tierCounts.danger++;
    else if (reg.tier === 2) tierCounts.directive++;
    else if (reg.tier === 1) tierCounts.watch++;
    else tierCounts.calm++;
  }

  const indexPayload = {
    schema: 'bionda-briefing-archive-v1',
    updatedAt: new Date().toISOString(),
    scheduleKst: ['08:00', '18:00'],
    retentionDays: 3,
    maxSlots: 6,
    latest: {
      slot: slotInfo.slot,
      slotLabelKst: slotInfo.slotLabelKst,
      url: `./api/briefing/${slotInfo.filename}`,
      latestAliasUrl: './api/briefing/latest.jpg',
      sizeBytes: jpgBuf.length,
      quality: jpgQuality
    },
    archives: kept.map(item => ({
      slot: item.slot,
      slotLabelKst: `${item.slot.slice(0, 10)} ${item.slot.slice(11, 13)}:00 KST`,
      filename: item.name,
      url: `./api/briefing/${item.name}`,
      sizeBytes: item.size
    }))
  };
  fs.writeFileSync(path.join(BRIEFING_DIR, 'index.json'), JSON.stringify(indexPayload, null, 2), 'utf8');

  const briefingJson = {
    schema: 'bionda-briefing-v1',
    generatedAt: new Date().toISOString(),
    generatedKst: `${formatKstDate(Date.now())} ${stampStr.slice(6)} KST`,
    corridor: '고속국도 제12호선 (광주대구선 · 기상청 도로기상 14번)',
    latestImage: indexPayload.latest,
    archiveIndexUrl: './api/briefing/index.json',
    summary: {
      total: enrichRegions.length,
      ...tierCounts,
      headline: `긴급(빨강) ${tierCounts.danger} · 제설지시(주황) ${tierCounts.directive} · 관심·비(노랑) ${tierCounts.watch} · 평온 ${tierCounts.calm}`
    },
    regions: enrichRegions
  };
  fs.writeFileSync(BRIEFING_JSON_PATH, JSON.stringify(briefingJson, null, 2), 'utf8');

  console.log(`[브리핑 생성 완료] ${slotInfo.filename} (${jpgBuf.length} bytes, quality=${jpgQuality})`);
  console.log(`[보관 현황] 유지 ${kept.length}건 (최대 3일/6슬롯), 삭제 ${deleted.length}건`);
  console.log(`[요약 JSON] public/api/briefing.json (${fs.statSync(BRIEFING_JSON_PATH).size} bytes)`);

  chromeProc.kill();
  server.closeAllConnections?.();
  server.close();
  try { fs.rmSync(profDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[브리핑 생성 오류]', err);
      process.exit(1);
    });
}

module.exports = {
  resolveBriefingSlot,
  parseSlotMs,
  pruneOldBriefingFiles
};
