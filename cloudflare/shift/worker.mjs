import core from '../../lib/bionda-core.js';

const H = 3600000;
const areas = new Set(core.SHORT_TERM_12_REGIONS.map(r => r.id));
const stages = ['예비살포','본살포','실제 살포'];
const types = ['없음','비','비/눈','눈','소나기','빗방울','빗방울/눈날림','눈날림'];
const isStr = (s,n=100) => typeof s === 'string' && s.length > 0 && s.length <= n;
const uuid = s => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const number = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);

async function gridWeather(grid, base, env) {
  const key = core.getServiceKey(env);
  if (!key) throw Error('KMA_SERVICE_KEY 미설정');
  const hub = /^[\w-]{20,26}$/.test(key);
  const url = new URL('getUltraSrtNcst',hub ? core.APIHUB_FCST_BASE : core.DATA_GO_KR_BASE);
  url.search = new URLSearchParams({serviceKey:core.deEncodedKey(key),
    dataType:'JSON',pageNo:1,numOfRows:30,base_date:core.datePart(base),base_time:core.timePart(base),...grid});
  if(hub)url.searchParams.set('authKey',core.deEncodedKey(key));
  const res = await fetch(url,{signal:AbortSignal.timeout(10000)});
  if (!res.ok) throw Error('기상청 실황 조회 실패');
  const items = core.parseKmaForecastJson(await res.text()).filter(i => i.baseDate === core.datePart(base)
    && i.baseTime === core.timePart(base) && Number(i.nx)===grid.nx && Number(i.ny)===grid.ny);
  const vals = Object.fromEntries(items.map(i=>[i.category,i.obsrValue]));
  const type = /^[0-7]$/.test(String(vals.PTY)) ? types[Number(vals.PTY)] : null;
  const temp = number(vals.T1H);
  if (!type && temp===null) return null;
  return {time:core.isoKst(base),temp,type,wet:type===null?null:type!=='없음'};
}

export async function collect(env, time) {
  const base=core.baseObservation(time), groups=new Map(), writes=[];
  function store(kind,id,value) {
    const at=Date.parse(value.time);
    if (!Number.isFinite(at) || at>time || at<=time-24*H) return;
    writes.push(env.DB.prepare('INSERT INTO weather VALUES(?,?,?,?,?) ON CONFLICT(kind,location,hour) DO UPDATE SET at=excluded.at,payload=excluded.payload WHERE excluded.at>=weather.at')
      .bind(kind,id,Math.floor(at/H)*H,at,JSON.stringify(value)));
  }
  for (const r of core.SHORT_TERM_12_REGIONS) {
    const key=r.grid.nx+','+r.grid.ny;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  const results=await Promise.allSettled([...(Array.from(groups.values(),async rows=>{
    const weather=await gridWeather(rows[0].grid,base,env);
    if (weather) for(const r of rows) store('area',r.id,weather);
  })),(async()=>{
    const res=await fetch('https://bionda.pages.dev/api/road-obs?line=14',{signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw Error('노면관측 조회 실패');
    for(const {stnId,name,time,lat,lon,temp,roadTemp,surfaceCode,surfaceState} of (await res.json()).stations)
      store('station',String(stnId),{time,name,lat,lon,temp,roadTemp,surfaceCode,surfaceState});
  })()]);
  writes.push(env.DB.prepare('DELETE FROM weather WHERE at<=?').bind(time-24*H),
    env.DB.prepare('DELETE FROM operations WHERE at<?').bind(time-72*H));
  await env.DB.batch(writes);
  if(results.some(r=>r.status==='rejected')) console.warn('실황 일부 미수신',results.filter(r=>r.status==='rejected').length);
}

function validRecord(r, now) {
  if (!r || !Number.isSafeInteger(r.at) || r.at>now || r.at<now-72*H) return false;
  if(r.type==='areaBatch') return stages.includes(r.stage) && Array.isArray(r.areas)
    && r.areas.length===areas.size && new Set(r.areas).size===areas.size && r.areas.every(a=>areas.has(a));
  if(r.type==='trip') return uuid(r.id) && isStr(r.name) && Number.isInteger(r.duration)
    && r.duration>0 && r.duration<=720 && Array.isArray(r.legs) && r.legs.length>0 && r.legs.length<=6
    && r.legs.every(l=>l && Number.isInteger(l.s) && l.s>=0 && l.s<=2 && isStr(l.name));
  if(r.type==='end' || r.type==='review') return uuid(r.trip);
  if(r.trip && !(uuid(r.trip) && Number.isInteger(r.leg) && r.leg>=0 && r.leg<6)) return false;
  if(!isStr(r.point) || !isStr(r.label)) return false;
  if(r.type==='field') return uuid(r.trip) && Number.isFinite(r.air) && r.air>=-60 && r.air<=60 && ['wet','dry','snow','other'].includes(r.surface);
  return r.type==='spread' && (!r.area || areas.has(r.area)) && (r.trip || r.area) && stages.includes(r.stage);
}

export async function handler(request,env,now=Date.now()) {
  const url=new URL(request.url), origin=request.headers.get('Origin');
  const headers={'Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json'};
  const reply=(status,data)=>new Response(data==null?null:JSON.stringify(data),{status,headers});
  if(origin && origin!==url.origin && origin!=='https://poeticecho.github.io') return reply(403,{error:'origin'});
  if(origin) headers['Access-Control-Allow-Origin']=origin;
  if(request.method==='OPTIONS') {
    headers['Access-Control-Allow-Methods']='GET, PUT, OPTIONS';
    headers['Access-Control-Allow-Headers']='Authorization, Content-Type';
    return reply(204,null);
  }
  if(!env.DB) return reply(503,{error:'storage unavailable'});
  if(url.pathname==='/history' && request.method==='GET') {
    const {results}=await env.DB.prepare('SELECT kind,location,payload FROM weather WHERE at>? AND at<=? ORDER BY at').bind(now-24*H,now).all();
    headers['Cache-Control']='public, max-age=60';
    return reply(200,results.map(r=>({kind:r.kind,id:r.location,...JSON.parse(r.payload)})));
  }
  if(url.pathname!=='/operations') return reply(404,{error:'path'});
  if(!env.SHIFT_TEAM_TOKEN) return reply(503,{error:'handover unavailable'});
  if(request.headers.get('Authorization')!=='Bearer '+env.SHIFT_TEAM_TOKEN) return reply(401,{error:'근무자 인증 필요'});
  if(request.method==='GET') {
    const {results}=await env.DB.prepare('SELECT id,revision,payload FROM operations WHERE at>=? ORDER BY at').bind(now-72*H).all();
    return reply(200,results.map(r=>({id:r.id,revision:r.revision,record:JSON.parse(r.payload)})));
  }
  if(request.method!=='PUT') return reply(405,{error:'method'});
  const body=await request.text();
  if(body.length>4096) return reply(413,{error:'size'});
  let op;
  try {op=JSON.parse(body);} catch {return reply(400,{error:'json'});}
  if(!op || !uuid(op.id) || !Number.isSafeInteger(op.revision) || op.revision<0 || !validRecord(op.record,now))
    return reply(400,{error:'기록 형식 또는 시각 확인'});
  const payload=JSON.stringify(op.record);
  const result=op.revision===0
    ? await env.DB.prepare('INSERT OR IGNORE INTO operations VALUES(?,?,1,?)').bind(op.id,op.record.at,payload).run()
    : await env.DB.prepare('UPDATE operations SET at=?,revision=revision+1,payload=? WHERE id=? AND revision=?')
      .bind(op.record.at,payload,op.id,op.revision).run();
  if(result.meta.changes) return reply(200,{revision:op.revision+1});
  const saved=await env.DB.prepare('SELECT payload,revision FROM operations WHERE id=?').bind(op.id).first();
  return saved?.payload===payload ? reply(200,{revision:saved.revision}) : reply(409,{error:'다른 근무자가 수정했습니다. 최신 기록을 확인하세요.'});
}

export default {
  fetch: (request,env)=>handler(request,env),
  scheduled: (event,env,ctx)=>ctx.waitUntil(collect(env,event.scheduledTime))
};
