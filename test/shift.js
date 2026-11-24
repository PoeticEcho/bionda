(() => {
'use strict';
const $ = id => document.getElementById(id);
const H = 3600000, THREE = 3*H, MIN = 60000;
const base = 'https://bionda.pages.dev';
const demoDay = '2026-11-24';
const towns = ['함양','거창','고령','화원'];
// Representative observation points within each leg. A point reading describes only that location.
const sections = [
  {area:'namsang', stations:[['14206','함양'],['14409','죽산천교'],['14207','남상졸음']]},
  {area:'gajo', stations:[['14208','거창휴']]},
  {area:'seongsan', stations:[['14209','양전교'],['14103','논공휴'],['14410','논공교']]}
];
const regions = new Map(sampleRows.map(r=>[r.id,r]));
const node = (tag, text, cls) => {
  const n=document.createElement(tag);
  if (text!=null) n.textContent=text;
  if (cls) n.className=cls;
  return n;
};
function button(label, action) {
  const b=node('button',label); b.type='button'; b.onclick=action; return b;
}
function ktime(ms) {return new Date(ms+9*H).toISOString().slice(0,16);}
function stamp(ms) {return Number.isFinite(ms)?ktime(ms).slice(5).replace('T',' '):'미수신';}
function readTime(s) {
  if (s && typeof s==='object' && s.date && s.time) {
    const d=s.date,t=s.time;
    s=d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8)+'T'+t.slice(0,2)+':'+t.slice(2,4)+':00+09:00';
  }
  return typeof s==='string'?Date.parse(s):NaN;
}
function inputMs(id) {return Date.parse($(id).value+':00+09:00');}
function temperature(v) {return Number.isFinite(v)?v+'℃':'미수신';}
function sectionName(i) {return towns[i]+' ↔ '+towns[i+1];}
function legsFor(from,to,shape,near,facility,ramp) {
  if(shape==='취약구간') return [{s:near,name:facility+' '+ramp,facility:true}];
  const path=[],step=Math.sign(to-from);
  for(let a=from;a!==to;a+=step) path.push([a,a+step]);
  const pairs=shape==='왕복' ? [...path,...path.map(([a,b])=>[b,a]).reverse()] : path;
  return pairs.map(([a,b])=>({s:Math.min(a,b),name:towns[a]+' → '+towns[b]}));
}
let demo=false, screen='hours', selected=null, refreshing=false, loadSeq=0, error='';
let observations=[], forecasts=[], precip=new Map(), forecastAt=NaN;
let hints=null, hintUntil=0, picked='', quickTarget=null;
const now=()=>demo?Date.parse(($('scenario').value==='snow'?'2026-11-19':$('clock').value==='22:56'?'2026-11-23':demoDay)+'T'+$('clock').value+':00+09:00'):Date.now();
function shiftStart(at) {
  const start=Date.parse(ktime(at).slice(0,10)+'T18:00:00+09:00');
  return at<start?start-24*H:start;
}
let archive=[], historyError='', focusCurrent=true, demoRounds=[];
const handover=new ShiftHandover(()=>{if(!demo)paint();});
const prefix='bionda:snow-helper:test:1:';
let demoStore=new Map();
// Store the whole column in one write. Existing point records and trip records
// still use the same per-location timeline when a batch is displayed.
function entries() {
  const list=[];
  if(demo) list.push(...demoStore.values());
  else try {
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(!k?.startsWith(prefix)) continue;
      try {const r=JSON.parse(localStorage.getItem(k));if(r?.type)list.push({...r,localKey:k});} catch {}
    }
  } catch {error='이 기기에서 저장소를 사용할 수 없습니다.';}
  if(!demo)list.push(...handover.list());
  const expanded=[], seen=new Set();
  function add(r) {
    if(r.type==='spread' && r.area){
      const key=JSON.stringify([r.area,r.trip,r.leg,r.point,r.at,r.stage]);
      if(seen.has(key))return;
      seen.add(key);
    }
    expanded.push(r);
  }
  // Prefer the batch label if an identical manual mark already exists.
  for(const batch of list.filter(r=>r.type==='areaBatch').sort((a,b)=>Number(!!b.sharedId)-Number(!!a.sharedId))){
    for(const area of batch.areas){
      const name=regions.get(area)?.name||area;
      add({type:'spread',area,stage:batch.stage,at:batch.at,point:'site:'+name,label:name+' 현장',batch:true,sharedId:batch.sharedId,localKey:batch.localKey});
    }
  }
  for(const r of list.sort((a,b)=>Number(!!b.sharedId)-Number(!!a.sharedId)))if(r.type!=='areaBatch')add(r);
  return expanded;
}
function save(record) {
  const k=record.type==='areaBatch'?'all:'+record.at+':'+record.stage:crypto.randomUUID();
  if(demo) demoStore.set(k,record);
  else if(handover.token) handover.enqueue(record);
  else localStorage.setItem(prefix+k,JSON.stringify(record));
}
function activeTrips(records) {
  const ended=new Set(records.filter(r=>r.type==='end' && r.at<=now()).map(r=>r.trip));
  return records.filter(r=>r.type==='trip' && r.at<=now() && !ended.has(r.id));
}
function legTasks(records,trip,leg) {
  const latest=new Map();
  for(const r of records) {
    if(r.trip!==trip.id || r.leg!==leg || r.type!=='spread' || r.at>now()) continue;
    if(!latest.has(r.point) || latest.get(r.point).at<r.at) latest.set(r.point,r);
  }
  return latest.size?[...latest.values()].map(r=>({point:r.point,label:r.label,at:r.at,due:r.at+THREE})):
    [{point:'',label:'실제 살포 시각 미입력',at:null,due:trip.at+THREE}];
}

function freshness(at,minutes) {return Number.isFinite(at)&&at<=now()&&now()-at<=minutes*MIN;}
function judgement(task,evidence) {
  if(now()<task.due) return '점검 예정';
  if(!task.point || !evidence || !freshness(evidence.time,15) || evidence.time<task.due) return '현장 확인 필요';
  if(!Number.isFinite(evidence.air) || !['dry','wet'].includes(evidence.surface)) return '현장 확인 필요';
  if(evidence.surface==='dry' || (Number.isFinite(evidence.air)&&evidence.air>4)) return '현재 조건 미충족';
  if(evidence.surface==='wet' && evidence.air<=4) return evidence.continued?'재살포 검토':'습윤 지속 확인';
  return '현장 확인 필요';
}
function siteEvidence(task,records,trip,li) {
  const s=observations.find(r=>r.stnId===task.point);
  const options=[];
  if(s) options.push({time:readTime(s.time),air:s.temp,surface:({1:'dry',2:'wet',3:'wet'})[s.surfaceCode],source:s.name});
  for(const r of records) if(r.type==='field' && r.trip===trip.id && r.leg===li && r.point===task.point && r.at<=now()){
    options.push({time:r.at,air:r.air,surface:r.surface,source:'현장 확인',continued:r.surface==='wet'});
  }
  return options.filter(o=>Number.isFinite(o.time)).sort((a,b)=>b.time-a.time)[0];
}
function forecastLine(area,due) {
  const r=forecasts.find(f=>f.id===area);
  const wanted=Math.floor(Math.max(due,now())/H)*H;
  const series=(r?.hours||[]).filter(h=>readTime(h.time)>=wanted && readTime(h.time)<=wanted+2*H);
  const label=r?.name||regions.get(area)?.name||area;
  if(!series.length) return label+' · 해당 시간 예보 미수신';
  return label+' 예보 · '+series.map(h=>stamp(readTime(h.time)).slice(-5)+' '+temperature(h.temp)+' '+(h.type==='없음'?'무강수':h.type||'강수형태 미수신')).join(' → ');
}
function roundNotes() {
  return demoRounds.filter(r=>r.at<=now()).map(r=>{
    const due=r.at+THREE;
    return stamp(r.at)+' 출발 · '+(now()<r.end?'작업 중':'종료 '+stamp(r.end).slice(-5)+' · '+r.count+'건')+
      ' · '+stamp(due).slice(-5)+' 출발 기준 기상 점검';
  });
}
function paintCards() {
  const records=entries(), trips=activeTrips(records);
  const cards=trips.map(trip=>{
    const card=node('article',null,'card');
    const tasks=trip.legs.map((_,i)=>legTasks(records,trip,i));
    const all=tasks.flat(), dep=trip.at+THREE;
    const earliest=Math.min(...all.map(t=>t.due));
    const checked=records.some(r=>r.trip===trip.id && r.at>=dep && r.at<=now() && ['review','spread','field'].includes(r.type));
    const next=checked?earliest:Math.min(dep,earliest);
    const due=now()>=next;
    if(due) card.classList.add('due');
    const head=node('div',null,'summary');
    head.append(node('strong',stamp(next),'time'),node('h3',trip.name),node('span',due?'점검 시각 도달':'다음 점검','status'));
    card.append(head,node('p',stamp(trip.at)+' 출발 · 출발 기준 점검 '+stamp(dep)+' · 편도 예상 '+trip.duration+'분'));
    const eta=trip.at+trip.duration*MIN;
    card.append(node('p',trip.name.includes(' ↔ ')?'예상 회차 '+stamp(eta)+' · 복귀 '+stamp(eta+trip.duration*MIN):'예상 도착 '+stamp(eta)));
    if(now()>=dep && !checked && earliest>dep) {
      card.append(button('출발 기준 기상 점검 완료',()=>{
        try { save({type:'review',trip:trip.id,at:now()});paint(); }
        catch { $('feed').textContent='점검 완료 상태를 저장하지 못했습니다.'; }
      }));
    }
    trip.legs.forEach((leg,i)=>{
      const box=node('div',null,'leg'), route=sections[leg.s];
      box.append(node('h4',leg.name+(leg.facility?' · '+sectionName(leg.s):'')));
      for(const task of tasks[i].sort((a,b)=>a.due-b.due)) {
        const ev=siteEvidence(task,records,trip,i);
        box.append(node('strong',judgement(task,ev)+' · '+stamp(task.due)+' · '+task.label));
        if(task.at) box.append(node('p','실제 살포 '+stamp(task.at)+(ev?' · '+ev.source+' '+stamp(ev.time)+' · 대기 '+temperature(ev.air)+' · '+({dry:'건조',wet:'습윤'}[ev.surface]||'노면 확인 필요'):'')));
        box.append(node('p',forecastLine(route.area,task.due)+' · 자료 '+stamp(forecastAt)));
      }
      const rain=precip.get(route.area);
      box.append(node('p',(regions.get(route.area)?.name||'')+' 강수 실황 · '+(rain?rain.type+' · '+stamp(rain.time)+(freshness(rain.time,90)?'':' · 지난 자료'):'미수신')));
      if(rain && freshness(rain.time,90) && ['비','빗방울','소나기'].includes(rain.type)) box.append(node('p','일반 비가 이어지면 제설제가 씻겨갈 수 있습니다. 강우 종료와 잔습을 현장에서 확인하세요.'));
      const details=node('details'); details.open=due;
      details.append(node('summary',leg.facility?'인근 본선 관측 · 연결로 현장 확인 필요':'구간 내 관측 지점'));
      const facts=node('div',null,'facts');
      for(const [id,label] of route.stations){
        const s=observations.find(v=>v.stnId===id);
        facts.append(node('div',s?(s.name+' · '+stamp(readTime(s.time))+(freshness(readTime(s.time),15)?'':' · 지난 자료')+' | 대기 '+temperature(s.temp)+' · 노면 '+temperature(s.roadTemp)+' · '+(s.surfaceState||'상태 미수신')):label+' · 관측 미수신','station'));
      }
      details.append(facts);box.append(details);
      const ops=node('div',null,'actions');
      ops.append(button('살포 시각 입력',()=>openAction(trip,i,'spread')),button('현장 상태 입력',()=>openAction(trip,i,'field')));
      box.append(ops);card.append(box);
    });
    const ops=node('div',null,'actions');ops.append(button('운행 종료',()=>openAction(trip,0,'end')));card.append(ops);
    return {next,card};
  }).sort((a,b)=>a.next-b.next);
  const latest=latestGrid(records).filter(r=>!r.trip);
  const batches=new Map();
  for(const r of latest.filter(r=>r.batch)){
    const key=r.at+' '+r.stage;
    if(!batches.has(key))batches.set(key,[]);
    batches.get(key).push(r);
  }
  for(const group of batches.values()){
    const r=group[0],dueAt=r.at+THREE,c=node('article',null,'card'+(dueAt<=now()?' due':''));
    c.append(node('h3','전 구간 '+r.stage+' · '+group.length+'곳 점검'),node('p',stamp(r.at)+' 실제 살포'),
      node('strong',stamp(dueAt)+' 재살포 점검'),node('p',group.map(v=>regions.get(v.area)?.name||v.area).join(' · ')),
      node('p','각 구간의 잔습과 실측 대기온도를 확인하세요.'));
    cards.push({next:dueAt,card:c});
  }
  for(const r of latest.filter(r=>!r.batch)){
    const dueAt=r.at+THREE, c=node('article',null,'card'+(dueAt<=now()?' due':''));
    c.append(node('h3',regions.get(r.area)?.name+' · '+r.label),node('p',stamp(r.at)+' 실제 '+r.stage),
      node('strong',stamp(dueAt)+' 재살포 점검'),node('p','같은 구간의 노면이 계속 젖어 있고 실측 대기가 4℃ 이하인지 확인하세요.'));
    cards.push({next:dueAt,card:c});
  }
  if(demo)for(const text of roundNotes()){
    const c=node('article',null,'card');c.append(node('h3','함양 ↔ 고령 · 고령 ↔ 화원'),node('p',text),node('small','본선·취약구간 작업 현황 · 지점별 실제 살포 시각 미확인'));cards.push({next:0,card:c});
  }
  cards.sort((a,b)=>a.next-b.next);
  $('cards').replaceChildren(...(cards.length?cards.map(r=>r.card):[node('p','차량을 출발시키면 이곳에 점검 시각과 해당 구간의 기상이 표시됩니다.','empty')]));
}
function seedDemo() {
  demoStore.clear();
  demoRounds=[];
  const when=(s)=>Date.parse(s+':00+09:00');
  if($('scenario').value==='snow') {
    for(const time of ['00:00','06:00']) save({type:'areaBatch',areas:[...regions.keys()],stage:'예비살포',at:when('2026-11-19T'+time)});
  } else if($('scenario').value==='night') {
    for(const [start,end] of [['2026-11-23T23:30','2026-11-24T01:00'],['2026-11-24T04:20','2026-11-24T06:00']]) {
      demoRounds.push({at:when(start),end:when(end),count:3});
    }
  } else {
    save({type:'spread',area:'seongsan',at:when('2026-11-24T02:10'),stage:'예비살포',point:'site:성산면',label:'고령 ↔ 화원 · 성산면'});
  }
}
function demoWeather() {
  if($('scenario').value==='snow') {
    forecasts=sampleRows.map(r=>({...r,hours:(snowNovember19[r.id]||[]).map(([time,temp,type,pty])=>({time,temp,type,pty,wet:pty!=null && pty!=='0'}))}));
    forecastAt=Date.parse('2026-11-19T05:27:00+09:00');
    if(now()<forecastAt)forecasts=forecasts.map(r=>({...r,hours:[]}));
    observations=[];precip.clear();archive=[];return;
  }
  const start=Date.parse('2026-11-23T15:00:00+09:00');
  forecasts=sampleRows.map(r=>({...r,hours:r.temp.map((temp,i)=>({
    time:new Date(start+i*H).toISOString(),temp,wet:r.rain.includes(i),pty:r.rain.includes(i)?'1':'0',type:r.rain.includes(i)?'비':'없음'
  }))}));
  // Reported 23:00–09:00 forecast. Later snowfall is a separate training scenario.
  const night={
    hamyang:[[8,8,8,7,7,6,4,4,3,3,4],['비','빗방울']],
    jigok:[[7,7,7,7,6,5,4,3,2,2,3],['비','비']],
    sudong:[[7,8,8,8,7,6,4,4,3,3,4],['비','빗방울']],
    geochang:[[6,6,6,5,4,3,2,2,1,2,3],[]],
    namsang:[[7,7,6,4,3,3,2,1,1,1,2],['비']],
    namha:[[6,6,6,5,4,3,2,2,1,2,3],[]],
    gajo:[[8,6,5,4,2,1,0,-1,-1,-1,0],[]],
    gaya:[[7,6,6,4,3,2,0,-1,-1,0,0],[]],
    yaro:[[8,7,7,5,5,3,2,1,0,1,2],['비']],
    ssangnim:[[8,8,8,8,7,6,5,4,3,3,4],['비']],
    daegaya:[[8,7,8,8,7,6,5,4,3,3,4],['비']],
    seongsan:[[9,8,8,9,8,7,6,4,4,4,4],['비','빗방울']],
    okpo:[[9,8,9,9,8,7,5,4,3,3,4],['비','빗방울']]
  };
  for(const r of forecasts){
    const [temps,types]=night[r.id];
    r.hours=r.hours.slice(8);
    temps.forEach((v,i)=>Object.assign(r.hours[i],{temp:v,type:types[i]||'없음',wet:!!types[i],pty:types[i]==='빗방울'?'5':types[i]?'1':'0'}));
  }

  observations=sections.flatMap((s,idx)=>s.stations.map(([stnId,name])=>({stnId,name,time:new Date(now()).toISOString(),
    temp:idx===0?5:3,roadTemp:idx===0?4:1,surfaceCode:idx===1?1:2,surfaceState:idx===1?'건조':'습윤'})));
  precip=new Map(sections.map(s=>[s.area,{type:'무강수',time:now()}]));
  archive=[];
  forecastAt=Date.parse('2026-11-23T22:56:00+09:00');
}
async function api(path) {
  const r=await fetch(base+path,{signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw Error('HTTP '+r.status);
  return r.json();
}
async function refresh() {
  if(demo) {demoWeather();paint();return;}
  const seq=++loadSeq;refreshing=true;paint();
  const areas=[...new Set(activeTrips(entries()).flatMap(t=>t.legs.map(l=>sections[l.s].area)))];
  const [fc,obs,hist]=await Promise.allSettled([api('/api/short-term-12?roster=13'),api('/api/road-obs?line=14'),handover.request('/history')]);
  if(seq!==loadSeq||demo)return;
  const issues=[];
  if(hist.status==='fulfilled' && Array.isArray(hist.value)){archive=hist.value;historyError='';}
  else historyError='지난 24시간 실황 연결 지연';

  if(fc.status==='fulfilled' && Array.isArray(fc.value.regions)){forecasts=fc.value.regions;forecastAt=readTime(fc.value.updatedAt);}
  else issues.push('시간별예보');
  if(obs.status==='fulfilled'&&Array.isArray(obs.value.stations)) observations=obs.value.stations; else issues.push('노면관측');
  const current=await Promise.allSettled(areas.map(async id=>{
    const region=forecasts.find(r=>r.id===id);
    if(!Number.isFinite(region?.lat)||!Number.isFinite(region.lon)) throw Error();
    const data=await api('/api/forecast?lat='+region.lat+'&lon='+region.lon);
    const v=data.analysis?.now;
    if(!v || !v.type || !Number.isFinite(readTime(v.time))) throw Error();
    return [id,{type:v.type==='없음'?'무강수':v.type,time:readTime(v.time)}];
  }));
  if(seq!==loadSeq||demo)return;
  for(const item of current) if(item.status==='fulfilled') precip.set(...item.value); else if(!issues.includes('강수 실황')) issues.push('강수 실황');
  error=issues.length?issues.join(' · ')+' 연결 지연 · 자료 시각을 확인하세요.':'';
  refreshing=false;

  paint();
}
function observedHours(r) {
  const floor=Math.floor(now()/H)*H;
  const hours=new Map(r.hours.filter(h=>demo || readTime(h.time)>=floor).map(h=>[readTime(h.time),h]));
  for(const o of archive) {
    const at=readTime(o.time);
    if(o.kind==='area' && o.id===r.id && at<=now() && at>=now()-24*H)
      hours.set(Math.floor(at/H)*H,{...o,source:'실황'});
  }
  return [...hours.values()];
}
function rebuildHints() {
  const records=entries(), at=now(), floor=Math.floor(at/H)*H;
  const signature=JSON.stringify([floor,forecasts,archive,observations,records,records.filter(r=>r.type==='field' && freshness(r.at,15)).length, observations.filter(o=>freshness(readTime(o.time),15)).length,
    records.filter(r=>r.type==='spread' && r.at+THREE<=at).length]);
  if(hints.input===signature)return;
  const byId=new Map();
  for(const row of regions.values()){
    const r=forecasts.find(v=>v.id===row.id)||{...row,hours:[]};
    const hours=observedHours(r);
    let items=spreadingHints(hours,at);
    const areaRecords=records.filter(v=>v.area===r.id && v.at<=at && v.type==='spread');
    const lastRain=archive.filter(o=>o.kind==='area' && o.id===r.id && o.wet===true && phase(o)==='rain' && readTime(o.time)<=at && readTime(o.time)>=at-12*H).sort((a,b)=>readTime(b.time)-readTime(a.time))[0];
    if(lastRain && !items.some(i=>i.stage==='노면 확인' || i.stage==='예비살포')){
      const cold=hours.find(h=>readTime(h.time)>=floor && temp(h)!==null && temp(h)<=4);
      if(cold)items.push({stage:'노면 확인',at:floor,last:floor,label:'잔습 확인',text:stamp(readTime(lastRain.time))+' 강수 실황 · '+stamp(readTime(cold.time))+' 대기 '+temp(cold)+'℃. 강우 종료와 실제 노면 물기를 확인하세요.'});
    }
    const lastBatch=areaRecords.filter(v=>v.batch || !v.trip && v.point==='site:'+r.name).sort((a,b)=>b.at-a.at)[0];
    if(lastBatch) {
      const firstHour=Math.ceil((lastBatch.at+THREE)/H)*H;
      items=items.filter(item=>{
        if(item.stage!=='예비살포'||item.at>=firstHour)return true;
        if(item.onset && item.onset<firstHour || item.last<firstHour)return false;
        item.at=firstHour;return true;
      });
    }
    for(const rec of latestGrid(areaRecords)){
      const due=rec.at+THREE;
      if(due<shiftStart(at) || due>at+48*H)continue;
      const ev=siteEvidence({point:rec.point},records,{id:rec.trip},rec.leg);
      const status=judgement({point:rec.point,due},ev);
      const cell=Math.max(floor,Math.floor(due/H)*H);
      items.push({stage:'재점검',at:cell,last:cell,label:stamp(due).slice(-5)+' '+status,
        text:rec.label+' · 실제 '+stamp(rec.at)+' · '+stamp(due)+' 재점검 · '+status+' · 습윤 지속과 실측 대기 4℃ 이하를 확인하세요.'});
    }
    const areasSeen=new Set();
    for(const field of records.filter(v=>v.type==='field' && v.surface==='snow' && freshness(v.at,15))){
      const trip=records.find(v=>v.type==='trip'&&v.id===field.trip);
      if(sections[trip?.legs[field.leg]?.s]?.area!==r.id || areasSeen.has(field.point))continue;
      const latest=records.filter(v=>v.type==='field'&&v.trip===field.trip&&v.leg===field.leg&&v.point===field.point&&v.at<=at).sort((a,b)=>b.at-a.at)[0];
      if(latest!==field)continue;
      areasSeen.add(field.point);
      items.push({stage:'본살포',at:floor,last:floor,label:'본살포 검토',text:field.label+' · '+stamp(field.at)+' 현장 차로 적설 확인. 적설 깊이에 맞춰 본살포와 제설 방법을 판단하세요.'});
    }
    byId.set(r.id,items);
  }
  hints={input:signature,byId};
}
function clearHints(message='') {hints=null;hintUntil=0;$('hintReason').textContent=message;}
function summary(start,end) {
  const box=$('outlook');box.replaceChildren();
  if(!hints){
    box.append(node('p',forecasts.length?'제설 힌트를 켜면 비가 그친 뒤의 예비살포 시간대와 강설 시 본살포 검토 구간이 표시됩니다.':'시간별예보 수신 대기'));
    return;
  }
  if(demo){
    for(const text of roundNotes())box.append(node('p',text,'review-line'));
    const finished=demoRounds.filter(r=>r.end<=now());
    if(finished.length)box.append(node('small','완료 '+finished.length+'회차 · '+finished.reduce((sum,r)=>sum+r.count,0)+'건'));
  }
  if(!demo){
    const lastWet=archive.filter(o=>o.kind==='area' && o.wet && readTime(o.time)>=shiftStart(now()) && readTime(o.time)<=now())
      .sort((a,b)=>readTime(b.time)-readTime(a.time))[0];
    if(lastWet)box.append(node('p','최근 강수 실황 '+stamp(readTime(lastWet.time))+' · '+(regions.get(lastWet.id)?.name||lastWet.id)+' '+lastWet.type,'review-line'));
    if(!entries().some(v=>v.type==='spread' && v.at<=now() && v.at>=shiftStart(now())))box.append(node('p','최근 살포 여부 미확인 · 인계받은 작업은 과거 시간 칸에 입력하세요.'));
  }
  for(const stage of ['재점검','예비살포','본살포','노면 확인']){
    const groups=new Map();
    for(const r of regions.values()) for(const item of hints.byId.get(r.id)||[]) {
      if(item.stage!==stage || item.last<start || item.at>end)continue;
      const key=item.at+'|'+item.last+'|'+(item.label||'')+'|'+(item.onset||item.until||'');
      if(!groups.has(key))groups.set(key,{item,rows:[]});
      groups.get(key).rows.push(r);
    }
    if(!groups.size && stage!=='예비살포')continue;
    const card=node('div',null,'outlook-card');card.append(node('strong',stage+(stage==='노면 확인'?'':' 검토')));
    if(!groups.size) {
      const available=forecasts.some(r=>r.hours.some(h=>readTime(h.time)>=start && readTime(h.time)<=end && phase(h)!=='unknown'));
      card.append(node('p',!available?'해당 시간 예보 미수신 · 판단 보류':stage==='본살포'?'이 시간대에 강설·진눈깨비 근거 없음. 차로 적설을 확인하면 본살포를 판단하세요.':'이 시간대에 예비살포 후보를 뒷받침하는 예보가 없습니다.'));
    }else{
      for(const {item,rows} of [...groups.values()].sort((x,y)=>x.item.at-y.item.at)){
        const text=stamp(item.at).slice(-5)+(item.until?'~'+stamp(item.until).slice(-5)+' 전':item.last>item.at?'~'+stamp(item.last).slice(-5):'')+' · '+rows.map(r=>r.name).join(', ');
        const b=button((item.label?item.label+' · ':'')+(item.onset?stamp(item.onset).slice(-5)+' 강설 예정 · ':'')+text,()=>{
          const t=Math.max(start,item.at);
          const cell=gridCell(rows[0].id,t);
          if(cell){cell.scrollIntoView({block:'nearest',inline:'center'});cell.focus({preventScroll:true});}
          explain(rows[0],item);
        });
        card.append(b);
      }
    }
    box.append(card);
  }
}
function gridCell(id,t){return $('matrix').querySelector('td[data-area="'+id+'"][data-at="'+t+'"]');}
function explain(r,item){
  $('detailHeading').textContent=r.county+' '+r.name+' · '+item.stage+' 검토';
  $('detailText').textContent=item.text;
  $('detail').showModal();
}
function latestGrid(records) {
  const latest=new Map();
  for(const r of records.filter(r=>r.type==='spread' && r.at<=now())){
    const key=JSON.stringify([r.trip||r.area,r.leg??'',r.point]);
    if(!latest.has(key)||latest.get(key).at<r.at)latest.set(key,r);
  }
  return [...latest.values()].filter(r=>r.area);
}
function paintHours() {
  const floor=Math.floor(now()/H)*H;
  const start=shiftStart(now());
  const tomorrowEnd=Date.parse(ktime(now()+24*H).slice(0,10)+'T23:00:00+09:00');
  const end=$('range').value==='tomorrow'?tomorrowEnd:floor+(Number($('range').value)-1)*H;
  $('forecastSource').textContent=(demo?'모의 예보':'기상청 예보')+' · 자료 '+stamp(forecastAt)+(hints?' · 비온다 자체 판단 '+stamp(now()+hintUntil-Date.now())+'까지':'');
  $('hints').setAttribute('aria-pressed',String(!!hints));$('hints').textContent=hints?'제설 힌트 끄기':'제설 힌트 켜기';$('hints').disabled=false;

  summary(floor,end);

  const records=entries(),recent=latestGrid(records);
  const table=node('table'),header=table.createTHead().insertRow();
  header.append(node('th','지역'));
  for(let t=start;t<=end;t+=H){
    const head=node('th'); head.scope='col';
    head.dataset.at=t;
    if(picked && t<=floor){
      const pick=button(stamp(t),()=>openGridTime(head));
      pick.append(node('small','전 구간'));
      pick.setAttribute('aria-label',stamp(t)+' 전 구간 '+picked);
      head.classList.add('can-place');head.append(pick);
    }else head.textContent=stamp(t);
    head.append(node('small',t===floor?'현재':t<floor?(demo?'보관 예보':'실황'):'예보'));
    if(t===floor)head.classList.add('current');
    header.append(head);
  }
  const body=table.createTBody(),pastRoad=new Map();
  for(const o of archive.filter(v=>v.kind==='station' && readTime(v.time)<=now() && readTime(v.time)>=start)){
    const area=forecasts.filter(v=>Number.isFinite(v.lat)&&Number.isFinite(v.lon)).reduce((best,r)=>{
      const distance=Math.hypot((o.lat-r.lat)*111,(o.lon-r.lon)*91);
      return distance<best.distance?{id:r.id,distance}:best;
    },{distance:28});
    if(!area.id)continue;
    const key=area.id+'|'+Math.floor(readTime(o.time)/H)*H;
    if(!pastRoad.has(key))pastRoad.set(key,[]);
    pastRoad.get(key).push(o);
  }
  for(const r of [...regions.values()].map(row=>forecasts.find(r=>r.id===row.id)||{...row,hours:[]}).sort((a,b)=>(a.routeOrder||0)-(b.routeOrder||0))){
    const row=body.insertRow();row.append(node('th',r.county+' '+r.name));
    const hours=new Map(observedHours(r).map(h=>[readTime(h.time),h]));
    for(let t=start;t<=end;t+=H){
      const cell=row.insertCell(),h=hours.get(t);
      cell.dataset.area=r.id;cell.dataset.at=t;cell.tabIndex=-1;
      if(t<floor)cell.classList.add('past');
      if(h?.wet)cell.classList.add('wet');
      if(Number.isFinite(h?.temp)&&h.temp<=0)cell.classList.add('cold');
      cell.append(node('strong',h?temperature(h.temp):'—'),node('small',h?.type==='없음'?'무강수':h?.type||'미수신'));
      if(t===floor && h)cell.append(node('small',h.source==='실황'?'실황':'예보'));
      const stations=pastRoad.get(r.id+'|'+t);
      if(stations?.length){
        const b=button('노면 '+stations.length+'곳',()=>{
          $('detailHeading').textContent=r.name+' 인근 도로관측';
          $('detailText').textContent=stations.map(o=>o.name+' · '+stamp(readTime(o.time))+' · 노면 '+temperature(o.roadTemp)+' · '+(o.surfaceState||'상태 미수신')).join(' / ');
          $('detail').showModal();
        });cell.append(b);
      }
      if(picked&&t<=floor){
        cell.classList.add('can-place');cell.tabIndex=0;
        cell.setAttribute('aria-label',r.name+' '+stamp(t)+' '+picked+' 시각 선택');
      }
      for(const item of hints?.byId.get(r.id)||[]) if(t>=item.at && t<=item.last){
        const b=button(({예비살포:'🚜',본살포:'❄', '노면 확인':'⌕',재점검:'◷'})[item.stage]+' '+(item.label||item.stage+' 검토'),()=>explain(r,item));
        b.className='hint '+(item.stage==='본살포'?'main-hint':'');b.title=item.text;b.setAttribute('aria-label',r.name+' '+stamp(t)+' '+item.stage+' 검토');cell.append(b);
      }
      for(const rec of records.filter(e=>e.type==='spread'&&e.area===r.id && e.at>=t&&e.at<t+H&&e.at<=now())){
        const mark=node('small',(rec.stage==='본살포'?'❄ ':'🚜 ')+rec.stage+' '+stamp(rec.at).slice(-5)+' 완료','actual');
        if(!demo && (rec.sharedId || rec.localKey)){const b=button(mark.textContent,()=>editSpread(rec,t));b.className='actual';cell.append(b);}else cell.append(mark);
      }
      for(const rec of recent.filter(e=>e.area===r.id && e.at+THREE>=t && e.at+THREE<t+H)){
        cell.append(node('small','◷ '+stamp(rec.at+THREE).slice(-5)+(rec.at+THREE<=now()?' 점검 시각 도달':' 재살포 점검'),'actual'));
      }
    }
  }
  const pane=$('matrix'), before=pane.scrollLeft;
  pane.replaceChildren(table);
  if(focusCurrent){focusCurrent=false;requestAnimationFrame(centerCurrent);}
  else pane.scrollLeft=before;
}
function centerCurrent(){
  const pane=$('matrix'), head=pane.querySelector('th.current');
  if(head)pane.scrollLeft+=head.getBoundingClientRect().left-pane.getBoundingClientRect().left-pane.querySelector('th').offsetWidth-6;

}
function paintRules() {
  const q=$('query').value.trim().replace(/\s/g,'');
  const matches=terms.filter(t=>t.join(' ').replace(/\s/g,'').includes(q));
  $('terms').replaceChildren(...matches.map(([topic,title,condition,act,source,note])=>{
    const d=node('details',null,'entry');d.append(node('summary',title+' · '+condition),node('p',(topic==='살포밀도'?'소금 / 염수 / 계 (g/㎡) · ':'')+act),node('small',source));
    if(note)d.append(node('p',note));return d;
  }));
  if(!matches.length)$('terms').textContent='일치하는 기준이 없습니다.';
}
function paint() {
  if(hints&&Date.now()>=hintUntil)clearHints('산출 후 10분이 지났습니다. 현재 예보로 다시 확인할 수 있습니다.');
  if(hints)rebuildHints();
  $('crew').hidden=demo;
  $('crew').textContent=handover.token?'근무 인계 설정':'근무 인계 연결';
  const pending=handover.pending().length;
  $('crewStatus').textContent=demo?'모의 입력은 이 화면에서만 유지됩니다.':[handover.message||(!handover.token?'이 기기 기록 · 다른 근무자 살포 여부 미확인':'근무 인계 연결'),pending?'공유 대기 '+pending+'건':'',historyError].filter(Boolean).join(' · ');
  $('source').textContent=(demo?'모의 상황':'실시간 시험판')+' · '+stamp(now())+' KST';
  $('feed').textContent=demo?$('scenario').selectedOptions[0].textContent+' · 사례 재현':refreshing?'기상 자료를 불러오는 중…':error||'예보 수신 '+stamp(forecastAt)+' · 5분 간격 갱신';
  $('simulation').hidden=!demo;$('mode').textContent=demo?'실시간으로 돌아가기':'모의 상황 열기';
  for(const id of ['shift','hours','rules'])$(id).hidden=screen!==id;
  for(const b of document.querySelectorAll('[data-screen]'))b.setAttribute('aria-pressed',String(b.dataset.screen===screen));
  if(screen==='shift')paintCards();else if(screen==='hours')paintHours();else paintRules();
}
function bounds(id) {
  const t=now();$(id).max=ktime(t);$(id).value=ktime(t);
}
function formRoute() {
  return legsFor(Number($('from').value),Number($('to').value),$('shape').value,Number($('near').value),$('facility').value.trim(),$('ramp').value);
}
function showRoute() {
  const facility=$('shape').value==='취약구간';
  $('towns').hidden=facility;$('facilityBox').hidden=!facility;$('facility').required=facility;
  for(const opt of $('to').options)opt.disabled=opt.value===$('from').value;
  if($('to').value===$('from').value)$('to').value=[...$('to').options].find(o=>!o.disabled).value;
  $('itinerary').textContent=formRoute().map(l=>l.name).join(' / ');
}
function openAction(trip,li,kind) {
  selected={trip,li,kind};const leg=trip.legs[li],isEnd=kind==='end';
  $('actionHeading').textContent={spread:'실제 살포 시각',field:'현장 실측',end:'운행 종료 확인'}[kind];
  $('actionLeg').textContent=isEnd?trip.name:leg.name;
  $('point').replaceChildren();
  if(leg.facility)$('point').add(new Option(leg.name,'facility'));
  else{
    for(const [id,name] of sections[leg.s].stations)$('point').add(new Option(name+' 관측지점',id));
    const prior=legTasks(entries(),trip,li).filter(t=>t.point.startsWith('site:'));
    for(const t of prior)$('point').add(new Option(t.label,t.point));
    $('point').add(new Option('다른 현장 위치 입력','custom'));
    $('point').add(new Option('위치 선택',''),0);$('point').value='';
  }
  $('pointLabel').hidden=isEnd;$('point').required=!isEnd;
  $('measure').hidden=kind!=='field';$('air').required=$('surface').required=kind==='field';
  $('air').value='';$('surface').value='';$('site').value='';updateSite();
  bounds('actionTime');$('actionTime').min=ktime(trip.at);$('actionError').textContent='';
  $('action').showModal();
}
function updateSite() {
  const show=selected?.kind!=='end'&&$('point').value==='custom';$('siteLabel').hidden=!show;$('site').required=show;
}
$('actionForm').onsubmit=e=>{
  e.preventDefault();const {trip,li,kind}=selected,at=inputMs('actionTime');
  if(!Number.isFinite(at)||at<trip.at||at>now()){$('actionError').textContent='출발 이후 실제 시각을 입력하세요.';return;}
  let point=$('point').value,label=$('point').selectedOptions[0]?.textContent;
  if(point==='custom'){label=$('site').value.trim().normalize('NFC');if(!label)return;point='site:'+label;}
  const record={type:kind,at,trip:trip.id,leg:li,point,label};
  if(kind==='spread'){
    const previous=entries().find(r=>r.area && r.trip===trip.id && r.leg===li && r.point===point);
    Object.assign(record,{area:previous?.area||sections[trip.legs[li].s].area,stage:'실제 살포'});
  }
  if(kind==='field'){record.air=$('air').valueAsNumber;record.surface=$('surface').value;}
  try{save(record);}catch{$('actionError').textContent='이 기기에 저장할 수 없습니다.';return;}
  $('action').close();paint();
};
$('tripForm').onsubmit=e=>{
  e.preventDefault();const at=inputMs('depart'),duration=$('duration').valueAsNumber,legs=formRoute();
  if(!Number.isFinite(at)||at>now()||!legs.length||($('shape').value==='취약구간'&&!$('facility').value.trim())){
    $('tripError').textContent='실제 출발 시각과 작업 구간을 확인하세요.';return;
  }
  const name=legs[0].facility?legs[0].name:towns[$('from').value]+($('shape').value==='왕복'?' ↔ ':' → ')+towns[$('to').value];
  try{save({type:'trip',id:crypto.randomUUID(),at,duration,legs,name});}catch{$('tripError').textContent='이 기기에 저장할 수 없습니다.';return;}
  $('newTrip').close();paint();refresh();
};
towns.forEach((name,i)=>{for(const id of ['from','to'])$(id).add(new Option(name,i));});
sections.forEach((_,i)=>$('near').add(new Option(sectionName(i),i)));
$('from').value='2';$('to').value='3';
for(const id of ['shape','from','to','near','facility','ramp'])$(id).oninput=showRoute;
$('dispatch').onclick=()=>{bounds('depart');$('tripError').textContent='';showRoute();$('newTrip').showModal();};
$('point').onchange=updateSite;
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>b.closest('dialog').close();
for(const b of document.querySelectorAll('[data-screen]'))b.onclick=()=>{screen=b.dataset.screen;paint();};
$('mode').onclick=()=>{
  demo=!demo;loadSeq++;refreshing=false;forecasts=[];observations=[];precip.clear();forecastAt=NaN;error='';clearHints();
  chooseStage('');focusCurrent=true;demoRounds=[];archive=[];historyError='';if(demo)seedDemo();
  refresh();
};
$('refresh').onclick=()=>{pollCrew();refresh();};$('clock').onchange=()=>{clearHints();refresh();};$('query').oninput=paintRules;$('range').onchange=paintHours;
$('hints').onclick=async()=>{
  if(hints){clearHints();paint();return;}
  const b=$('hints');b.disabled=true;b.textContent='산출 중…';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  $('hintReason').textContent='';focusCurrent=true;
  hints={};hintUntil=Date.now()+10*MIN;b.disabled=false;paint();
};
$('scenario').onchange=()=>{clearHints();focusCurrent=true;seedDemo();refresh();};
$('clock').onchange=()=>{focusCurrent=true;refresh();};
$('crew').onclick=()=>{$('crewCode').value='';$('crewError').textContent='';$('crewDialog').showModal();};
$('crewForm').onsubmit=async e=>{e.preventDefault();await handover.login($('crewCode').value);$('crewCode').value='';if(handover.message)$('crewError').textContent=handover.message;else $('crewDialog').close();};
$('disconnect').onclick=()=>{handover.login('');$('crewDialog').close();};

const palette=$('tools'),grid=$('matrix');
const stages=['예비살포','본살포'];
function chooseStage(stage) {
  picked=stage;
  for(const b of palette.querySelectorAll('[data-stage]'))b.setAttribute('aria-pressed',String(stage===b.dataset.stage));
  $('placement').textContent=stage?stage+' · 맨 위 시간은 전 구간, 지역 칸은 한 곳을 선택합니다.':'아이콘을 놓거나 선택 후 눌러 주세요. 맨 위 시간은 전 구간, 지역 칸은 한 곳에 반영합니다.';
  if(screen==='hours')paint();
}
function openGridTime(cell) {
  if(!picked||!cell)return;
  const t=Number(cell.dataset.at);
  if(t>now()){$('placement').textContent='미래 시간에는 실제 살포를 표시할 수 없습니다.';return;}
  const all=cell.tagName==='TH';
  $('resolveConflict').hidden=true;
  quickTarget={area:cell.dataset.area,t,stage:picked,legs:[],all};
  $('quickScopeLabel').hidden=all;
  $('quickApply').textContent=all?'전 구간 반영':'표에 반영';
  const areaName=regions.get(quickTarget.area)?.name||quickTarget.area;
  $('quickTitle').textContent=all?'전 구간 살포를 하시나요?':'실제 '+picked;
  $('quickArea').textContent=all?stamp(t)+' 시간 칸 · 예보표 '+regions.size+'개 지역 전체에 '+picked+'를 반영합니다.':areaName+' · '+stamp(t)+' 시간 칸';
  $('quickTime').min=ktime(t);$('quickTime').max=ktime(Math.min(t+H-MIN,now()));
  $('quickTime').value=ktime(now()-t<H?now():t);
  if(!all){
    const scope=$('quickScope');scope.replaceChildren(new Option(areaName+' 현장','area'));
    for(const trip of activeTrips(entries()))trip.legs.forEach((leg,i)=>{
      if(trip.at>=t+H)return;
      quickTarget.legs.push({trip,li:i});
      scope.add(new Option(leg.name+' · '+stamp(trip.at)+' 출발',String(quickTarget.legs.length-1)));
    });
  }
  $('quickError').textContent='';quickDue();$('quick').showModal();
}
function editSpread(rec,t) {
  const item=rec.sharedId && (handover.pending().find(x=>x.id===rec.sharedId)||handover.remote.get(rec.sharedId));
  const original=item?.record||(rec.localKey && JSON.parse(localStorage.getItem(rec.localKey)));
  if(!original)return;
  quickTarget={edit:original,localKey:rec.localKey,sharedId:rec.sharedId,revision:item?.revision,t};
  $('quickTitle').textContent=rec.batch?'전 구간 살포 시각 수정':'살포 시각 수정';
  $('quickArea').textContent=rec.label+(rec.batch?' · 전 구간에 반영':'');
  $('quickScopeLabel').hidden=true;$('quickTime').min=ktime(Math.min(shiftStart(now()),rec.at));$('quickTime').max=ktime(now());$('quickTime').value=ktime(rec.at);
  $('quickApply').textContent=rec.localKey&&handover.token?'수정 후 근무 인계에 공유':'수정 반영';
  $('quickError').textContent='';
  const conflict=rec.sharedId && handover.pending().find(x=>x.id===rec.sharedId);
  const server=conflict && handover.remote.get(rec.sharedId);
  $('resolveConflict').hidden=!(server && server.revision>conflict.revision && JSON.stringify(server.record)!==JSON.stringify(conflict.record));
  if(!$('resolveConflict').hidden)$('quickError').textContent='공유된 최신 시각 '+stamp(server.record.at)+' · 이 기기의 수정 대기 '+stamp(conflict.record.at);
  quickDue();$('quick').showModal();
}
$('resolveConflict').onclick=()=>{
  const id=quickTarget.sharedId;
  if(id)localStorage.removeItem(handover.key+id);
  $('quick').close();paint();handover.sync();
};
function quickDue(){
  const at=inputMs('quickTime');
  $('quickDue').textContent=Number.isFinite(at)?'재살포 점검 '+stamp(at+THREE):'실제 살포한 분을 선택하세요.';
}
$('quickTime').oninput=quickDue;
$('quickForm').onsubmit=e=>{
  e.preventDefault();const at=inputMs('quickTime'),q=quickTarget;
  if(q?.edit){
    if(!Number.isFinite(at)||at>now()||at<Date.parse($('quickTime').min+':00+09:00'))return;
    const updated={...q.edit,at};
    try {
      if(q.sharedId || handover.token) {
        handover.enqueue(updated,q.sharedId,q.revision);
        if(q.localKey)localStorage.removeItem(q.localKey);
      } else localStorage.setItem(q.localKey,JSON.stringify(updated));
    } catch { $('quickError').textContent='변경을 저장하지 못했습니다.';return; }
    $('quick').close();paint();return;
  }
  if(!q||at<q.t||at>=q.t+H||!Number.isFinite(at)||at>now())return;
  if(q.all){
    try {save({type:'areaBatch',stage:q.stage,at,areas:[...regions.keys()]});}
    catch {$('quickError').textContent='전 구간 입력을 저장하지 못했습니다.';return;}
    $('quick').close();chooseStage('');
    $('placement').textContent='전 구간 '+regions.size+'곳 · '+stamp(at)+' '+q.stage+' 반영 · '+stamp(at+THREE)+' 재살포 점검';
    grid.querySelector('thead th[data-at="'+q.t+'"]')?.scrollIntoView({block:'nearest',inline:'center'});
    return;
  }
  const link=q.legs[Number.parseInt($('quickScope').value,10)];
  if(link&&at<link.trip.at){$('quickError').textContent='차량 출발 이후 시각을 선택하세요.';return;}
  const place=regions.get(q.area)?.name||q.area;
  const leg=link?.trip.legs[link.li];
  const record={type:'spread',stage:q.stage,area:q.area,at,point:leg?.facility?'facility':'site:'+place,label:leg?.facility?leg.name:place+' 현장'};
  if(link)Object.assign(record,{trip:link.trip.id,leg:link.li});
  const exists=entries().some(r=>r.type==='spread'&&r.area===q.area&&r.at===at&&r.trip===record.trip&&r.leg===record.leg&&r.point===record.point&&r.stage===q.stage);
  if(!exists)try{save(record);}catch{$('quickError').textContent='이 기기에 저장할 수 없습니다.';return;}
  $('quick').close();chooseStage('');
  $('placement').textContent=place+' '+stamp(at).slice(-5)+' '+q.stage+' 반영 · '+stamp(at+THREE).slice(-5)+' 재살포 점검';
  gridCell(q.area,q.t)?.scrollIntoView({block:'nearest',inline:'center'});
};
grid.addEventListener('click',e=>{
  if(!picked)return;
  const c=e.target.closest('[data-at]');if(c){e.preventDefault();e.stopPropagation();openGridTime(c);}
},true);
grid.addEventListener('keydown',e=>{
  if(picked&&e.target.matches('td')&&['Enter',' '].includes(e.key)){e.preventDefault();openGridTime(e.target);}
});
let hover=null, touch=null, suppressTap=false;
function highlight(cell){
  hover?.classList.remove('drop-target');hover=cell?.matches('.can-place')?cell:null;hover?.classList.add('drop-target');
}
function track(x,y){
  const bounds=grid.getBoundingClientRect();
  if(y>=bounds.top && y<=bounds.bottom){
    if(x>bounds.right-28)grid.scrollLeft+=24;
    if(x<bounds.left+28)grid.scrollLeft-=24;
    if(y>bounds.bottom-22)grid.scrollTop+=18;
    if(y<bounds.top+22)grid.scrollTop-=18;
  }
  const target=document.elementFromPoint(x,y)?.closest('#matrix [data-at]');
  highlight(target);return target;
}
for(const b of palette.querySelectorAll('[data-stage]')){
  b.draggable=true;
  b.onclick=()=>{if(!suppressTap)chooseStage(picked===b.dataset.stage?'':b.dataset.stage);};
  b.ondragstart=e=>{
    if(touch){e.preventDefault();return;}
    chooseStage(b.dataset.stage);e.dataTransfer.setData('text/x-bionda-spread',picked);e.dataTransfer.effectAllowed='copy';
  };
  b.ondragend=()=>highlight(null);
  b.onpointerdown=e=>{
    if(e.pointerType==='mouse')return;
    touch={id:e.pointerId,x:e.clientX,y:e.clientY,drag:false};b.setPointerCapture(e.pointerId);
  };
  b.onpointermove=e=>{
    if(touch?.id!==e.pointerId)return;
    if(!touch.drag&&Math.hypot(e.clientX-touch.x,e.clientY-touch.y)>8){touch.drag=true;chooseStage(b.dataset.stage);}
    if(touch.drag){e.preventDefault();track(e.clientX,e.clientY);}
  };
  b.onpointerup=e=>{
    if(touch?.id!==e.pointerId)return;
    if(touch.drag){suppressTap=true;setTimeout(()=>{suppressTap=false;},350);openGridTime(track(e.clientX,e.clientY));}
    touch=null;highlight(null);
  };
  b.onpointercancel=()=>{touch=null;highlight(null);};
}
grid.ondragover=e=>{
  if(!picked||!e.dataTransfer.types.includes('text/x-bionda-spread'))return;
  e.preventDefault();e.dataTransfer.dropEffect='copy';track(e.clientX,e.clientY);
};
grid.ondrop=e=>{
  if(!stages.includes(e.dataTransfer.getData('text/x-bionda-spread')))return;
  e.preventDefault();highlight(null);openGridTime(e.target.closest('[data-at]'));
};
$('history').onclick=centerCurrent;
let lastMinute=Math.floor(now()/MIN);
setInterval(()=>{
  if(document.hidden)return;
  const m=Math.floor(now()/MIN);
  if(lastMinute!==m || (hints && Date.now()>=hintUntil)){lastMinute=m;paint();}
},1000);
let fetched=0;
function scheduled(){if(!demo&&!document.hidden&&!refreshing && Date.now()-fetched>=5*MIN){fetched=Date.now();refresh();}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){paint();scheduled();}});
window.addEventListener('storage',e=>{if(!demo && (e.key?.startsWith(prefix)||e.key?.startsWith(handover.key)))paint();});
function pollCrew(){if(!demo&&!document.hidden)handover.sync();}
setInterval(pollCrew,30000);document.addEventListener('visibilitychange',pollCrew);pollCrew();
setInterval(scheduled,30000);
scheduled();
})();
