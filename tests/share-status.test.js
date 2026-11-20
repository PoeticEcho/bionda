const test = require('node:test');
const assert = require('node:assert/strict');
const { briefingStatus } = require('../lib/share-status');

const hash = 'a'.repeat(64);
const midnight = '2026-12-01';

for (const [hour, id, retry] of [
  ['00:00', '2026-11-30-night', 1800],
  ['07:59', '2026-11-30-night', 60],
  ['08:00', '2026-12-01-morning', 300],
  ['09:00', '2026-12-01-morning', 1800],
  ['17:59', '2026-12-01-morning', 60],
  ['18:00', '2026-12-01-night', 300],
  ['19:00', '2026-12-01-night', 1800],
]) {
  test('KST ' + hour + ' serves only the current edition', async () => {
    const now = Date.parse(midnight + 'T' + hour + ':00+09:00');
    const slots = [];
    const response = await briefingStatus(slot => {
      slots.push(slot);
      return { edition_id: '2026-11-29-' + slot, bytes: 100, sha256: hash };
    }, now);
    const body = await response.json();
    assert.equal(body.edition_id, id);
    assert.deepEqual(slots, [body.slot]);
    assert.equal(response.status, 202);
    assert.equal(body.status, 'pending');
    assert.equal(body.image_url, undefined);
    assert.equal(response.headers.get('Retry-After'), String(retry));
    assert.equal(Date.parse(body.retry_at), now + retry * 1000);
  });
}

test('ready points to the version of the PNG recorded by its publisher', async () => {
  const generated_at = midnight + 'T08:28:00+09:00';
  const response = await briefingStatus(() => ({
    edition_id: midnight + '-morning', generated_at, sha256: hash, bytes: 155000,
  }), Date.parse(generated_at));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.status, 'ready');
  assert.equal(body.image_url, 'https://bionda.pages.dev/share/morning.png?v=' + hash);
  assert.equal(body.sha256, hash);
  assert.equal(body.bytes, 155000);
  assert.equal(body.generated_at, generated_at);
  assert.equal(body.collect_until, midnight + 'T09:00:00+09:00');
  assert.equal(body.next_edition_at, midnight + 'T18:00:00+09:00');
});

test('unpublished and unreadable manifests never authorize sending an image', async () => {
  const now = Date.parse(midnight + 'T18:01:00+09:00');
  for (const [read, code] of [
    [() => ({ edition_id: null }), 202],
    [() => ({ edition_id: midnight + '-night', sha256: '', bytes: 0 }), 202],
    [() => { throw Error('missing asset'); }, 503],
  ]) {
    const response = await briefingStatus(read, now);
    assert.equal(response.status, code);
    const body = await response.json();
    assert.equal(body.image_url, undefined);
    assert.equal(body.next_edition_at, '2026-12-02T08:00:00+09:00');
  }
});
