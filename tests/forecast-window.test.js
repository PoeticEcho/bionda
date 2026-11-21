const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/bionda-core');

for (const [now, start] of [
  ['2026-11-20T23:34:00+09:00', '2026-11-20T23:00:00+09:00'],
  ['2026-11-20T23:35:00+09:00', '2026-11-21T00:00:00+09:00'],
]) {
  test('Point and matrix share the precipitation, temperature and hour at ' + now, () => {
    const grid = { nx: 74, ny: 82 };
    const short = { items: [] }, ultra = { items: [] };
    for (let i = 0; i < 12; i++) {
      const t = core.kst(Date.parse(start) + i * 3600000);
      const slot = { fcstDate: core.datePart(t), fcstTime: core.timePart(t) };
      for (const [category, fcstValue] of [['TMP', '3'], ['POP', '40'], ['PTY', '0']]) {
        short.items.push({ ...slot, category, fcstValue });
      }
      // Include an out-of-window ultra value and a missing ultra slot.
      if (i <= 6 && i !== 2) {
        for (const [category, fcstValue] of [['T1H', '-2'], ['PTY', '3']]) {
          ultra.items.push({ ...slot, category, fcstValue });
        }
      }
    }
    const point = core.buildForecastResult(grid, Date.parse(now), [ultra, short, null].map(value => ({ status: 'fulfilled', value })));
    const matrix = core.buildShortTermRegionForecast({ region: { grid }, now: Date.parse(now), shortRes: short, ultraRes: ultra });
    assert.equal(point.windowStart, start);
    assert.equal(point.hours.length, 12);
    for (const [i, h] of point.hours.entries()) {
      const m = matrix.hours[i];
      const useUltra = i < 6 && i !== 2;
      assert.deepEqual([h.time, Number(h.temp), h.source, h.wet, h.chance], [m.time, m.temp, m.source, m.wet, m.pop]);
      assert.equal(h.wet, useUltra);
      assert.equal(h.chance, 40);
      assert.equal(Number(h.temp), useUltra ? -2 : 3);
      assert.equal(h.offset, i + 1);
    }
  });
}

test('Older bound overview and point forecasts use only a matching comparison grid', async () => {
  const { onRequest } = await import('../functions/api/[[path]].js');
  const snapshot = require('../public/api/short-term-12.json');
  const region = snapshot.regions.find(r => r.id === 'hamyang') || snapshot.regions[0];
  const point = { ok: true, updatedAt: snapshot.updatedAt, grid: region.grid, hours: [],
    analysis: { now: { wet: true } }, sources: { observed: 'observed' } };
  const other = { ...point, grid: { nx: 1, ny: 2 } };
  for (const path of ['/api/forecast', '/api/overview-bundle']) {
    const calls = [];
    const result = await onRequest({
      request: new Request('https://bionda.pages.dev' + path),
      env: { API_WORKER: { fetch: async req => {
        const key = new URL(req.url).pathname;
        calls.push(key);
        return Response.json(key === '/api/short-term-12' ? snapshot : key === '/api/forecast' ? point :
          { items: { a: { forecast: point }, b: { forecast: other } } });
      } } },
    });
    const data = await result.json();
    const forecast = data.items?.a.forecast || data;
    assert.deepEqual(calls, [path, '/api/short-term-12']);
    assert.deepEqual(forecast.hours.map(h => [h.time, h.chance, h.temp]), region.hours.slice(0, 12).map(h => [h.time, h.pop, h.temp]));
    assert.equal(forecast.analysis.now.wet, true);
    assert.equal(forecast.sources.observed, 'observed');
    if (data.items) assert.deepEqual(data.items.b.forecast.hours, []);
  }
});
