// Forecast hours are in KST. The six-hour tail is a planning window for residual
// moisture after rain, not a measured drying time or an official warning rule.
const HOUR = 3600000;
const TAIL = 6 * HOUR;
const DAY = 24 * HOUR;
const kst = ms => new Date(ms + 9 * HOUR).toISOString().slice(0, 16);
const stamp = ms => kst(ms).slice(5).replace('T', ' ');
function phase(h) {
  if (['어는비','어는 비','어는 이슬비'].includes(h.type)) return 'freezingRain';
  if (h.snowCm > 0 || ['2','3','6','7'].includes(String(h.pty))) return 'snow';
  if (h.wet === true || h.rainMm > 0 || ['1','4','5'].includes(String(h.pty))) return 'rain';
  if (h.wet === false || String(h.pty) === '0') return 'clear';
  return 'unknown';
}
function temp(h) {
  if (h.temp == null || h.temp === '') return null;
  const value = Number(h.temp);
  return Number.isFinite(value) ? value : null;
}

function snowWindows(hours, now, horizonHours = 24) {
  const floor = Math.floor(now / HOUR) * HOUR;
  const sorted = hours.map(h => ({ ...h, ms: Date.parse(h.time), phase: phase(h) }))
    .filter(h => h.ms >= floor - DAY && h.ms < floor + horizonHours * HOUR)
    .sort((a,b) => a.ms - b.ms);
  const windows = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    if (start.phase === 'clear' || start.phase === 'unknown') continue;
    while (i + 1 < sorted.length && sorted[i+1].ms - sorted[i].ms === HOUR &&
        sorted[i+1].phase === start.phase) i++;
    const end = sorted[i];
    const active = sorted.find(h => h.ms >= Math.max(start.ms, floor) && h.ms <= end.ms);
    if (start.phase !== 'rain') {
      if (active) windows.push({start, end, mode:start.phase, firstSnow:start.phase === 'snow' ? active : undefined,
        at:active.ms, rank:2});
      continue;
    }
    // Only uninterrupted, known precipitation-free hours can establish a window.
    const dry = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const h = sorted[j];
      const prev = sorted[j-1];
      if (h.ms-prev.ms !== HOUR || h.phase !== 'clear' || temp(h) === null) break;
      if (h.ms-end.ms > TAIL && !(temp(prev) !== null && temp(prev) <= 4 && temp(h) <= 4)) break;
      dry.push(h);
    }
    const firstCold = dry.find(h => temp(h) <= 4);
    const nextDry = dry.find(h => h.ms >= floor);
    const coldDuring = sorted.find(h => h.ms >= Math.max(start.ms,floor) && h.ms <= end.ms &&
      temp(h) !== null && temp(h) <= 4);
    const upcomingDry = dry.filter(h => h.ms >= floor);
    const cool = upcomingDry.find(h => temp(h) <= 4);
    const frost = upcomingDry.find(h => temp(h) <= 0);
    const minimum = upcomingDry.reduce((best,h) => !best || temp(h) < temp(best) ? h : best, null);
    if (!active && !cool) continue;
    let mode = 'rain';
    let at = active?.ms ?? floor;
    if (coldDuring && nextDry && cool) {
      windows.push({start, end, mode:'rainPatrol', at:coldDuring.ms, rank:1});
    }
    if (nextDry && cool) {
      mode = nextDry.ms < firstCold.ms ? 'candidate' : 'inspect';
      at = nextDry.ms;
    } else if (coldDuring) {
      mode = 'rainPatrol';
      at = coldDuring.ms;
    }
    windows.push({start, end, nextDry, cool, frost, minimum, mode, at,
      rank:frost ? 2 : cool || coldDuring ? 1 : 0});
  }
  return windows.sort((a,b) => b.rank - a.rank || a.at - b.at);
}

function timingAdvice(mode) {
  switch (mode) {
    case 'candidate': return '비가 실제로 그치면 교량·응달의 잔습과 실측 노면온도를 확인하세요. 물기가 남고 결빙이 우려되면 대기온도가 4℃ 이하로 떨어지기 전에 예비살포를 검토하세요. 노면이 말랐거나 비가 계속되면 이 후보는 보류합니다.';
    case 'inspect': return '무강수 예보가 시작될 때 이미 대기온도가 4℃ 이하이거나 앞서 그 수준에 도달합니다. 시간별예보로 4℃ 도달 전 살포 시각을 정할 수 없습니다. 실제 비가 그치는 즉시 잔습과 대기·노면온도를 확인하세요.';
    case 'rainPatrol': return '비가 이어지면 제설제가 씻겨갈 수 있습니다. 순찰 중 비가 막 시작되고 대기 4℃ 이하·노면 2℃ 이하이며 추가 하강이 예상되면 문서의 예비살포 기준을 적용하세요.';
    case 'snow': return '눈·진눈깨비가 흩날리기 시작하면 예비살포를 검토하고, 차로 적설을 확인해 본살포와 제설 방법을 판단하세요.';
    case 'freezingRain': return '어는비 예보가 있으므로 결빙 예상 구간과 공식 위험정보를 즉시 확인하고 예비살포 기준을 적용하세요.';
    default: return '강우 중에는 제설제가 씻겨갈 수 있습니다. 비가 그친 뒤 잔습과 기온 하강 전망을 확인하세요.';
  }
}
