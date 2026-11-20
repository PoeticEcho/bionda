const HOUR = 3_600_000;
const KST_OFFSET = 9 * HOUR;
const ORIGIN = 'https://bionda.pages.dev';

function currentEdition(now) {
  const local = new Date(now + KST_OFFSET);
  const hour = local.getUTCHours();
  const morning = hour >= 8 && hour < 18;
  const slot = morning ? 'morning' : 'night';
  if (hour < 8) local.setUTCDate(local.getUTCDate() - 1);
  local.setUTCHours(morning ? 8 : 18, 0, 0, 0);
  const start = local.getTime() - KST_OFFSET;
  return {
    slot,
    id: local.toISOString().slice(0, 10) + '-' + slot,
    start,
    next: start + (morning ? 10 : 14) * HOUR,
  };
}

function kstIso(ms) {
  return new Date(ms + KST_OFFSET).toISOString().slice(0, 19) + '+09:00';
}

async function briefingStatus(readMetadata, now = Date.now()) {
  const edition = currentEdition(now);
  const collectionEnd = edition.start + HOUR;
  const info = {
    edition_id: edition.id,
    slot: edition.slot,
    timezone: 'Asia/Seoul',
    collect_from: kstIso(edition.start),
    collect_until: kstIso(collectionEnd),
    next_edition_at: kstIso(edition.next),
  };
  const headers = { 'Cache-Control': 'no-store' };
  let metadata;
  let unavailable = false;
  try {
    metadata = await readMetadata(edition.slot);
  } catch {
    unavailable = true;
  }
  if (metadata?.edition_id === edition.id && /^[a-f0-9]{64}$/.test(metadata.sha256)
      && Number.isInteger(metadata.bytes) && metadata.bytes > 0) {
    const image = new URL('/share/' + edition.slot + '.png', ORIGIN);
    image.searchParams.set('v', metadata.sha256);
    return Response.json({
      ...info,
      status: 'ready',
      image_url: image.href,
      generated_at: metadata.generated_at,
      bytes: metadata.bytes,
      sha256: metadata.sha256,
    }, { headers });
  }

  const retryMinutes = now < collectionEnd ? 5 : 30;
  const retry = Math.min(edition.next, now + retryMinutes * 60_000);
  headers['Retry-After'] = String(Math.ceil((retry - now) / 1000));
  return Response.json({
    ...info,
    status: unavailable ? 'unavailable' : 'pending',
    message: unavailable ? '준비 상태를 확인할 수 없습니다. 다시 확인해 주세요.' : '이번 회차 PNG를 준비 중입니다. 다시 확인해 주세요.',
    retry_at: kstIso(retry),
  }, { status: unavailable ? 503 : 202, headers });
}

module.exports = { briefingStatus };
