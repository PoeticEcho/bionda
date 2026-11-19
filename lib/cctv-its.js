/**
 * 광주대구선(남원~대구) 고속도로 CCTV 목록 조회 및 19개 지점 매칭 모듈
 * - 국토교통부 국가교통정보센터(ITS) Open API (https://openapi.its.go.kr:9443/cctvInfo)
 * - 선택 환경변수 CCTV_SOURCE_URL 지정 시 해당 URL에서 동일 형식의 JSON을 받아옵니다.
 */

const CCTV_CACHE_TTL_SECONDS = 900; // 15분
const CCTV_UPSTREAM_TIMEOUT_MS = 10000;
const CCTV_ITS_ENDPOINT = 'https://openapi.its.go.kr:9443/cctvInfo';

// 남원 127.39°E ~ 대구 논공 128.45°E, 35.38°N ~ 35.80°N 전체 커버
const CCTV_BOUNDS = {
  minX: 127.25,
  maxX: 128.65,
  minY: 35.3,
  maxY: 35.9
};

/**
 * 19개 지점(관심지역 8 + 도로관측소 11) → 최인접/보조 CCTV 이름 매핑
 */
const CCTV_SITES = [
  // ── 관심지역 (8) ─────────────────────────────────────────────
  {
    id: 'dalseong-nambu',
    group: 'interest',
    name: '대구 달성군남부',
    sub: '현풍읍',
    nearest: { label: '논공교2', km: 8.09, note: '종점부' },
    aux: [{ label: '논공교3' }, { label: '논공휴게소' }]
  },
  {
    id: 'hamyang-jungbu',
    group: 'interest',
    name: '함양중부',
    sub: '지곡면',
    nearest: { label: '우명교', km: 2.68 },
    aux: [{ label: '원평교' }, { label: '죽산천교1' }]
  },
  {
    id: 'geochang-nambu',
    group: 'interest',
    name: '거창군남부',
    sub: '남상면',
    nearest: { label: '무촌2교', km: 0.56 },
    aux: [{ label: '송변교' }, { label: '오계교' }]
  },
  {
    id: 'hapcheon-seobuk',
    group: 'interest',
    name: '합천군서북부',
    sub: '야로면',
    nearest: { label: '야로대교1', km: 1.46 },
    aux: [{ label: '야로대교2' }, { label: '해인사' }]
  },
  {
    id: 'goryeong',
    group: 'interest',
    name: '고령군',
    sub: '대가야읍',
    nearest: { label: '안림천교', km: 2.29 },
    aux: [{ label: '회천대교' }, { label: '양전교' }]
  },
  {
    id: 'namwon',
    group: 'interest',
    name: '남원',
    sub: '남원시청',
    nearest: { label: '남원', km: 1.59 },
    aux: [{ label: '산곡' }, { label: '남원휴게소' }]
  },
  {
    id: 'hamyang-eup',
    group: 'interest',
    name: '함양',
    sub: '함양읍',
    nearest: { label: '교산', km: 1.8 },
    aux: [{ label: '두산' }, { label: '함양' }]
  },
  {
    id: 'geochang-eup',
    group: 'interest',
    name: '거창',
    sub: '거창읍',
    nearest: { label: '정장교', km: 2.29 },
    aux: [{ label: '거창' }, { label: '무촌2교' }]
  },

  // ── 도로관측소 (11) ──────────────────────────────────────────
  {
    id: '14205',
    group: 'observatory',
    code: '14205',
    name: '남원주차장(도)',
    sub: '50.8k',
    nearest: { label: '남원휴게소', km: 0.13 },
    aux: [{ label: '생태터널' }, { label: '남원' }]
  },
  {
    id: '14407',
    group: 'observatory',
    code: '14407',
    name: '번암교(도)',
    sub: '72.9k',
    tag: '목표·결빙',
    nearest: { label: '번암교', km: 0.04 },
    aux: [{ label: '번암1터널' }, { label: '지리산휴게소' }]
  },
  {
    id: '14102',
    group: 'observatory',
    code: '14102',
    name: '지리산휴(도)',
    sub: '75.4k',
    tag: '거점',
    nearest: { label: '지리산휴게소', km: 0.5 },
    aux: [{ label: '당동' }, { label: '번암교' }]
  },
  {
    id: '14408',
    group: 'observatory',
    code: '14408',
    name: '옥계1교(도)',
    sub: '86.2k',
    tag: '목표·결빙',
    nearest: { label: '옥계1교', km: 0.04 },
    aux: [{ label: '백전교' }]
  },
  {
    id: '14206',
    group: 'observatory',
    code: '14206',
    name: '함양(도)',
    sub: '95.0k',
    nearest: { label: '함양', km: 0.08 },
    aux: [{ label: '두산' }, { label: '교산' }]
  },
  {
    id: '14409',
    group: 'observatory',
    code: '14409',
    name: '죽산천교(도)',
    sub: '102.9k',
    tag: '목표·결빙',
    nearest: { label: '죽산천교1', km: 0.13 },
    aux: [{ label: '죽산교' }]
  },
  {
    id: '14207',
    group: 'observatory',
    code: '14207',
    name: '남상졸음(도)',
    sub: '115.3k',
    nearest: { label: '오계교', km: 0.75 },
    aux: [{ label: '무촌2교' }]
  },
  {
    id: '14208',
    group: 'observatory',
    code: '14208',
    name: '거창휴(도)',
    sub: '134.1k',
    nearest: { label: '거창휴게소', km: 0.19 },
    aux: [{ label: '가조터널', note: '외부대구' }]
  },
  {
    id: '14209',
    group: 'observatory',
    code: '14209',
    name: '양전교(도)',
    sub: '158.2k',
    nearest: { label: '양전교', km: 0.32 },
    aux: [{ label: '양전리2' }, { label: '안림천교' }]
  },
  {
    id: '14103',
    group: 'observatory',
    code: '14103',
    name: '논공휴(도)',
    sub: '169.2k',
    tag: '거점',
    nearest: { label: '논공휴게소', km: 0.16 },
    aux: [{ label: '논공휴게소2' }]
  },
  {
    id: '14410',
    group: 'observatory',
    code: '14410',
    name: '논공교(도)',
    sub: '171.3k',
    tag: '목표·결빙',
    nearest: { label: '논공교2', km: 0.3 },
    aux: [{ label: '논공교3' }, { label: '논공휴게소' }]
  }
];

function cctvUpstreamError(code, message, detail = {}) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail;
  return err;
}

function cctvFirstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function cctvToNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** CCTV 이름 비교용 정규화: 괄호 주석·공백 제거, 소문자 */
function normalizeCctvName(value) {
  return String(value || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * ITS 응답의 다양한 item 배열 위치를 재귀적으로 탐색합니다.
 */
function findCctvArray(node, depth = 0) {
  const looksLikeCctv = (item) =>
    item &&
    typeof item === 'object' &&
    (cctvFirstString(item, ['cctvurl', 'cctvUrl']) || (item.url && (item.name || item.cctvname)));

  if (Array.isArray(node)) {
    if (node.some(looksLikeCctv)) return node;
    return null;
  }
  if (!node || typeof node !== 'object' || depth > 6) return null;

  for (const key of ['item', 'items', 'data', 'list', 'body', 'response']) {
    if (key in node) {
      const found = findCctvArray(node[key], depth + 1);
      if (found) return found;
    }
  }
  for (const value of Object.values(node)) {
    const found = findCctvArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function readItsResultHeader(json) {
  const header = json && json.response && json.response.header;
  if (!header) return null;
  return {
    code: cctvFirstString(header, ['resultCode', 'resultcode', 'code']),
    message: cctvFirstString(header, ['resultMsg', 'resultmsg', 'message'])
  };
}

function normalizeCctvItem(item) {
  const url = cctvFirstString(item, ['cctvurl', 'cctvUrl', 'url']);
  if (!url) return null;
  const name = cctvFirstString(item, ['cctvname', 'cctvName', 'name']);
  const format = cctvFirstString(item, ['cctvformat', 'cctvFormat', 'format']);
  return {
    name: name || '(이름 없음)',
    url,
    format: format || (url.includes('.m3u8') ? 'HLS' : 'MP4'),
    x: cctvToNumber(cctvFirstString(item, ['coordx', 'coordX', 'x'])),
    y: cctvToNumber(cctvFirstString(item, ['coordy', 'coordY', 'y']))
  };
}

/** 이름 하나로 후보를 찾습니다: 정확 일치 → 부분 일치 */
function matchCctvLabel(label, cctvs) {
  const target = normalizeCctvName(label);
  if (!target) return { label, mode: 'none', items: [] };

  const exact = cctvs.filter((c) => normalizeCctvName(c.name) === target);
  if (exact.length) return { label, mode: 'exact', items: exact };

  const containsTarget = cctvs.filter((c) => normalizeCctvName(c.name).includes(target));
  if (containsTarget.length) return { label, mode: 'partial', items: containsTarget };

  const targetContainsName = cctvs.filter((c) => {
    const name = normalizeCctvName(c.name);
    return name.length >= 2 && target.includes(name);
  });
  if (targetContainsName.length) return { label, mode: 'partial', items: targetContainsName };

  return { label, mode: 'none', items: [] };
}

function buildCctvSites(cctvs) {
  let labelCount = 0;
  let matchedCount = 0;
  const unmatchedLabels = [];

  const sites = CCTV_SITES.map((site) => {
    const nearest = { ...site.nearest, ...matchCctvLabel(site.nearest.label, cctvs) };
    const aux = site.aux.map((entry) => ({ ...entry, ...matchCctvLabel(entry.label, cctvs) }));

    for (const entry of [nearest, ...aux]) {
      labelCount += 1;
      if (entry.items.length) matchedCount += 1;
      else unmatchedLabels.push(entry.label);
    }

    return {
      id: site.id,
      group: site.group,
      code: site.code || null,
      name: site.name,
      sub: site.sub || '',
      tag: site.tag || null,
      nearest: {
        label: nearest.label,
        km: nearest.km != null ? nearest.km : null,
        note: nearest.note || null,
        mode: nearest.mode,
        count: nearest.items.length,
        items: nearest.items
      },
      aux: aux.map((entry) => ({
        label: entry.label,
        note: entry.note || null,
        mode: entry.mode,
        count: entry.items.length,
        items: entry.items
      }))
    };
  });

  return {
    sites,
    stats: {
      sites: CCTV_SITES.length,
      labels: labelCount,
      matchedLabels: matchedCount,
      unmatchedLabels
    }
  };
}

function buildItsCctvUrl(apiKey) {
  const url = new URL(CCTV_ITS_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('type', 'ex');
  url.searchParams.set('cctvType', '1');
  url.searchParams.set('minX', String(CCTV_BOUNDS.minX));
  url.searchParams.set('maxX', String(CCTV_BOUNDS.maxX));
  url.searchParams.set('minY', String(CCTV_BOUNDS.minY));
  url.searchParams.set('maxY', String(CCTV_BOUNDS.maxY));
  url.searchParams.set('getType', 'json');
  return url.toString();
}

function isCctvConfigured(env = {}) {
  return Boolean(String(env.ITS_API_KEY || '').trim() || String(env.CCTV_SOURCE_URL || '').trim());
}

async function fetchItsCctvJson(env = {}, fetchImpl = fetch) {
  const customSource = String(env.CCTV_SOURCE_URL || '').trim();
  const apiKey = String(env.ITS_API_KEY || '').trim();

  if (!customSource && !apiKey) {
    throw cctvUpstreamError('ITS_API_KEY_MISSING', 'ITS_API_KEY 시크릿이 설정되지 않았습니다.', {
      howTo: [
        '배포: wrangler secret put ITS_API_KEY  (발급받은 키 붙여넣기)',
        '로컬: 프로젝트 루트 .dev.vars 또는 .env 파일에 ITS_API_KEY=발급받은키 추가',
        '이 키는 코드에 하드코딩하지 마세요. 저장소에 커밋되면 즉시 노출됩니다.'
      ]
    });
  }

  const sourceUrl = customSource || buildItsCctvUrl(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CCTV_UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetchImpl(sourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw cctvUpstreamError('UPSTREAM_HTTP_ERROR', `업스트림이 HTTP ${res.status}로 응답했습니다.`, {
        status: res.status,
        sample: body.slice(0, 300)
      });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw cctvUpstreamError('UPSTREAM_BAD_JSON', '업스트림 응답을 JSON으로 해석하지 못했습니다.', {
        sample: text.slice(0, 200)
      });
    }

    return { json, source: customSource ? 'custom' : 'its' };
  } catch (err) {
    if (err && err.code) throw err;
    const aborted = controller.signal.aborted || (err && err.name === 'AbortError');
    throw cctvUpstreamError(
      aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      aborted
        ? `업스트림 응답이 ${CCTV_UPSTREAM_TIMEOUT_MS / 1000}초 안에 오지 않았습니다.`
        : '업스트림에 연결하지 못했습니다.',
      { cause: String((err && err.message) || err) }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function buildCctvPayload(env = {}, fetchImpl = fetch) {
  const { json, source } = await fetchItsCctvJson(env, fetchImpl);

  const rawItems = findCctvArray(json) || [];
  const cctvs = [];
  const seen = new Set();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const cctv = normalizeCctvItem(item);
    if (!cctv) continue;
    const key = `${cctv.name}|${cctv.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cctvs.push(cctv);
  }

  if (cctvs.length === 0) {
    const header = readItsResultHeader(json);
    if (header && header.code && !['0', '00', '000', 'SUCCESS'].includes(header.code.toUpperCase())) {
      throw cctvUpstreamError('ITS_API_ERROR', `ITS API가 오류를 반환했습니다. (${header.code})`, {
        resultCode: header.code,
        resultMsg: header.message
      });
    }
  }

  cctvs.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const { sites, stats } = buildCctvSites(cctvs);

  return {
    ok: true,
    source: source === 'its' ? 'ITS 국가교통정보센터 Open API' : 'CCTV_SOURCE_URL',
    bounds: CCTV_BOUNDS,
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CCTV_CACHE_TTL_SECONDS,
    count: cctvs.length,
    cctvs,
    sites,
    stats
  };
}

module.exports = {
  CCTV_CACHE_TTL_SECONDS,
  CCTV_UPSTREAM_TIMEOUT_MS,
  CCTV_ITS_ENDPOINT,
  CCTV_BOUNDS,
  CCTV_SITES,
  cctvUpstreamError,
  normalizeCctvName,
  findCctvArray,
  readItsResultHeader,
  normalizeCctvItem,
  matchCctvLabel,
  buildCctvSites,
  buildItsCctvUrl,
  isCctvConfigured,
  fetchItsCctvJson,
  buildCctvPayload
};
