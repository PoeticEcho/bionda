import { SHORT_TERM_12_REGIONS, buildShortTerm12Payload, summarizeHourlyWindow } from './bionda-core.js';
import { loadPointForecast, insertGayaRow } from '../public/hourly-point.js';

export async function completeBoundHourlyResponse(response, request, service) {
  if (!response.ok) return response;
  const batch = await response.clone().json();
  if (!batch.ok || !Array.isArray(batch.regions) || batch.regions.some(r => r.id === 'gaya')) return response;
  const url = new URL(request.url);
  const point = await loadPointForecast(SHORT_TERM_12_REGIONS.find(r => r.id === 'gaya'),
    new URL('/api/forecast', url), target => service.fetch(new Request(target, { headers: request.headers })),
    url.searchParams.get('force') === '1');
  const regions = insertGayaRow(batch, SHORT_TERM_12_REGIONS, point, summarizeHourlyWindow);
  const result = buildShortTerm12Payload({ now: Date.parse(batch.updatedAt), regionResults: regions });
  const headers = new Headers(response.headers);
  for (const key of ['content-length', 'content-encoding', 'etag']) headers.delete(key);
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify({ ...batch, ...result }), { headers });
}
