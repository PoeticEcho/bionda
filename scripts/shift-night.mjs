// Archive public observations and forecast editions. Duty reports are read only by the local match command.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import core from '../lib/bionda-core.js';

const H=3600000, origin='https://bionda.pages.dev';
const roster=core.SHORT_TERM_12_REGIONS;
const dateKst=ms=>new Date(ms+9*H).toISOString().slice(0,10);
export const shiftDate=ms=>dateKst(ms-18*H);
const finite=v=>v!=null && v!=='' && Number.isFinite(Number(v))?Number(v):null;
function parseTime(value){
  if(value && typeof value==='object' && /^\d{8}$/.test(value.date) && /^\d{4}$/.test(value.time)){
    const {date:d,time:t}=value;
    return Date.parse(d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6)+'T'+t.slice(0,2)+':'+t.slice(2)+':00+09:00');
  }
  return typeof value==='string' && /(Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
}
function select(obj,keys){return Object.fromEntries(keys.map(k=>[k,obj[k]??null]));}
async function json(apiPath){
  for(let attempt=0;attempt<2;attempt++){
    try{
      const res=await fetch(origin+apiPath,{headers:{Accept:'application/json','User-Agent':'Bionda-Night-Weather/1.0 (+https://bionda.pages.dev/llms.txt)'},signal:AbortSignal.timeout(30000)});
      if(!res.ok)throw Error('HTTP '+res.status);
      return await res.json();
    }catch(e){if(attempt)throw e;}
  }
}

export async function sample(at,load=json,clock=Date.now){
  const night=shiftDate(at), start=Date.parse(night+'T18:00:00+09:00'), end=start+16*H;
  const observations=[],errors=[],received={areas:0,stations:0};
  const note=(name,e)=>errors.push(name+' · '+String(e.message||'응답 형식 확인').slice(0,160));
  function add(kind,id,value){
    const t=parseTime(value.time);
    if(t>=start && t<=end && t<=at)
      observations.push({kind,id,...value,time:new Date(t).toISOString()});
  }
  const grids=new Map();
  for(const r of roster){const key=r.grid.nx+','+r.grid.ny;if(!grids.has(key))grids.set(key,[]);grids.get(key).push(r);}
  async function capture(){
    const batch=await load('/api/short-term-12?roster=13');
    if(!Array.isArray(batch.regions)||!Number.isFinite(parseTime(batch.updatedAt)))throw Error('예보 시각 누락');
    if(parseTime(batch.updatedAt)<at-3*H)throw Error('지난 예보');
    const capturedAt=new Date(clock()).toISOString();
    const rows=batch.regions.flatMap(r=>{
      if(!roster.some(x=>x.id===r.id))return [];
      const hours=(r.hours||[]).filter(h=>parseTime(h.time)>=start&&parseTime(h.time)<=end)
        .map(h=>select(h,['time','temp','pty','type','wet','pop','rainMm','snowCm']));
      return hours.length?[{id:r.id,hours}]:[];
    });
    if(!rows.length)return null;
    return {capturedAt,updatedAt:batch.updatedAt,
      sources:select(batch.sources||{},['shortBase','ultraBase']),regions:rows};
  }
  const edition=capture().catch(e=>{note('시간별예보',e);return null;});
  const roads=(async()=>{
    const data=await load('/api/road-obs?line=14');
    if(!data.stations?.length)throw Error();
    for(const s of data.stations){
      if(!s.stnId||!Number.isFinite(parseTime(s.time))||parseTime(s.time)<at-H)continue;
      received.stations++;
      add('station',String(s.stnId),select(s,['name','lat','lon','time','temp','roadTemp','surfaceCode','surfaceState']));
    }
    if(!received.stations)throw Error('최근 도로관측 미수신');
  })().catch(e=>note('도로관측',e));
  const groups=[...grids.values()];
  for(let i=0;i<groups.length;i+=3)await Promise.all(groups.slice(i,i+3).map(async group=>{
    const first=group[0];
    try{
      const data=await load('/api/forecast?lat='+first.lat+'&lon='+first.lon);
      const v=data.analysis?.now;
      if(!v || !Number.isFinite(parseTime(v.time)) || (finite(v.temp)===null && !v.type))throw Error('실황 시각 또는 값 누락');
      if(parseTime(v.time)<at-2*H)throw Error('지난 격자 실황 '+new Date(parseTime(v.time)).toISOString());
      received.areas+=group.length;
      for(const r of group)add('area',r.id,{time:v.time,temp:finite(v.temp),type:v.type??null,wet:typeof v.wet==='boolean'?v.wet:null});
    }catch(e){note(group.map(r=>r.id).join('/'),e);}
  }));
  await roads;
  return {night,observations,edition:await edition,errors,received};
}

export function merge(previous,snapshot){
  const rows=new Map((previous?.observations??[]).map(r=>[[r.kind,r.id,r.time].join('|'),r]));
  for(const r of snapshot.observations)rows.set([r.kind,r.id,r.time].join('|'),r);
  const editions=[...(previous?.editions??[])];
  const e=snapshot.edition;
  if(e && !editions.some(v=>v.updatedAt===e.updatedAt && JSON.stringify(v.regions)===JSON.stringify(e.regions)))editions.push(e);
  return {night:snapshot.night,timezone:'Asia/Seoul',observations:[...rows.values()].sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id)),editions};
}

// Match only records known by the decision time. Missing station or region stays unknown.
export function compare(night,work,now=Date.now()){
  const start=Date.parse(night.night+'T18:00:00+09:00'),end=start+16*H;
  return work.map(row=>{
    const at=parseTime(row.at);
    if(!(at>=start && at<=end))throw Error('근무 시각은 해당 야간의 날짜와 시간대(+09:00)를 포함해야 합니다.');
    const state=t=>{
      if(t>now || t>end)return null;
      function latest(kind,id,maxAge){
        if(!id)return null;
        return night.observations.filter(r=>r.kind===kind && r.id===id && parseTime(r.time)<=t && parseTime(r.time)>=t-maxAge)
          .sort((a,b)=>parseTime(b.time)-parseTime(a.time))[0]??null;
      }
      const edition=night.editions.filter(e=>parseTime(e.capturedAt)<=t && parseTime(e.updatedAt)<=t && e.regions.some(r=>r.id===row.areaId && r.hours.some(h=>Math.floor(parseTime(h.time)/H)===Math.floor(t/H))))
        .sort((a,b)=>parseTime(b.capturedAt)-parseTime(a.capturedAt))[0];
      return {area:latest('area',row.areaId,H),station:latest('station',row.stationId,15*60000),
        forecast:edition?{capturedAt:edition.capturedAt,sources:edition.sources,hour:edition.regions.find(r=>r.id===row.areaId).hours.find(h=>Math.floor(parseTime(h.time)/H)===Math.floor(t/H))}:null};
    };
    return {at:row.at,section:row.section??null,stage:row.stage??null,basis:row.basis??'미확인',
      atWork:state(at),checkAt:new Date(at+3*H).toISOString(),checkKind:row.basis==='actual'?'실제 살포 후 재점검':row.basis==='departure'?'출발 후 기상 점검':'시각 성격 확인 필요',atCheck:state(at+3*H)};
  });
}

async function main(){
  const [mode,directory,report]=process.argv.slice(2);
  if(mode==='match'){
    const archive=JSON.parse(await fs.readFile(directory)), work=JSON.parse(await fs.readFile(report));
    console.log(JSON.stringify(compare(archive,work),null,2));return;
  }
  if(mode!=='collect'||!directory)throw Error('collect <저장 폴더> 또는 match <야간 JSON> <근무표 JSON>');
  const at=Date.now(),data=await sample(at), file=path.join(directory,data.night+'.json');
  console.log(data.night,'최근 수신 지역',data.received.areas,'관측소',data.received.stations,'보관 시간대 실황',data.observations.length,'예보지역',data.edition?.regions.length??0,'조회 실패',data.errors.join(',')||'없음');
  const start=Date.parse(data.night+'T18:00:00+09:00');
  await fs.mkdir(directory,{recursive:true});
  const status={checkedAt:new Date(at).toISOString(),night:data.night,received:data.received,errors:data.errors};
  await fs.writeFile(path.join(directory,'..','status.json'),JSON.stringify(status,null,2)+'\n');
  if(process.env.GITHUB_ACTIONS && data.errors.length)
    console.log('::warning::'+data.errors.join(' / ').replace(/[%\r\n]/g,' '));
  if(at>=start+17*H){
    // A deployment or manual run outside the night checks upstreams only.
    if(data.errors.length)process.exitCode=1;
    return;
  }
  if(data.observations.length || data.edition){
    await fs.mkdir(directory,{recursive:true});
    let previous;
    try{previous=JSON.parse(await fs.readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
    await fs.writeFile(file,JSON.stringify(merge(previous,data))+'\n');
  }
  if(data.errors.length || !data.observations.length)process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
