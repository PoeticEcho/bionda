import { briefingStatus } from '../../lib/share-status.js';

export async function onRequestGet({ request, env }) {
  return briefingStatus(async slot => {
    const url = new URL('/share/' + slot + '.json', request.url);
    const asset = await env.ASSETS.fetch(new Request(url));
    if (!asset.ok) throw new Error('Edition metadata is unavailable');
    return asset.json();
  });
}
