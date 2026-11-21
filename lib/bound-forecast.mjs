import { SHORT_TERM_12_REGIONS, analyze, forecastWindowStart, isoKst, kmaToWmoCode } from './bionda-core.js';

// Older bound Workers start point forecasts at the next hour. Reuse the comparison
// batch once per response, and only use a comparison row for the identical KMA grid.
const gridKey = grid => grid && grid.nx + ',' + grid.ny;
const comparisonGrids = new Set(SHORT_TERM_12_REGIONS.map(r => gridKey(r.grid)));

function alignPoint(point, row, startTime) {
  const start = Date.parse(startTime);
  const hours = [];
  for (const h of row?.hours || point.hours) {
    const offset = 1 + (Date.parse(h.time) - start) / 3600000;
    if (!Number.isInteger(offset) || offset < 1 || offset > 12) continue;
    if (row) {
      const chance = h.pop ?? null;
      hours.push({
        time: h.time, offset, type: h.type, wet: h.wet, pty: h.pty, lightning: h.lightning,
        chance, risk: !h.wet && chance != null && chance >= 50, amount: h.amount,
        rainMm: h.rainMm, snowCm: h.snowCm, temp: h.temp, humidity: h.humidity,
        wind: h.wind, vec: h.vec, windDir: h.windDir, sky: h.sky, skyLabel: h.skyLabel,
        weatherCode: kmaToWmoCode(h.sky, h.pty, h.lightning), snow: h.snow, source: h.source,
      });
    } else {
      hours.push({ ...h, offset });
    }
  }
  return { ...point, windowStart: startTime, hours, sources: { ...point.sources, ...row?.sources },
    analysis: analyze(hours, point.analysis?.now) };
}

export async function alignBoundForecast(response, isBundle, fetchComparison) {
  if (!response.ok) return response;
  const body = await response.clone().json();
  const points = isBundle ? Object.values(body.items || {}).map(item => item.forecast) : [body];
  const legacy = points.filter(p => p?.ok && !p.windowStart && Array.isArray(p.hours));
  if (!legacy.length) return response;

  let batch;
  if (legacy.some(p => comparisonGrids.has(gridKey(p.grid)))) {
    try {
      const res = await fetchComparison();
      if (res.ok) batch = await res.json();
    } catch { /* Keep genuine point forecasts if the comparison service is offline. */ }
  }
  const rows = new Map();
  let firstTime;
  for (const r of batch?.regions || []) {
    if (!r.hours?.length) continue;
    rows.set(gridKey(r.grid), r);
    if (!firstTime || r.hours[0].time < firstTime) firstTime = r.hours[0].time;
  }

  const aligned = new Map();
  for (const p of legacy) {
    // Avoid replacing live data with a batch left over from another forecast window.
    const pointStart = forecastWindowStart(Date.parse(p.updatedAt));
    const batchStart = forecastWindowStart(Date.parse(batch?.updatedAt));
    const row = pointStart.getTime() === batchStart.getTime() ? rows.get(gridKey(p.grid)) : null;
    const start = row ? (row.windowStart || firstTime) : isoKst(pointStart);
    aligned.set(p, alignPoint(p, row, start));
  }
  if (isBundle) {
    for (const item of Object.values(body.items)) {
      if (aligned.has(item.forecast)) item.forecast = aligned.get(item.forecast);
    }
  }
  const headers = new Headers(response.headers);
  for (const key of ['content-length', 'content-encoding', 'etag']) headers.delete(key);
  return Response.json(isBundle ? body : aligned.get(body), { headers });
}
