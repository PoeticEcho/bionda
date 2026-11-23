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
const now=()=>demo?Date.parse(($('clock').value==='22:56'?'2026-11-23':demoDay)+'T'+$('clock').value+':00+09:00'):Date.now();
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
      try {const r=JSON.parse(localStorage.getItem(k));if(r?.type)list.push(r);} catch {}
    }
  } catch {error='이 기기에서 저장소를 사용할 수 없습니다.';}
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
  for(const batch of list.filter(r=>r.type==='areaBatch')){
    for(const area of batch.areas){
      const name=regions.get(area)?.name||area;
      add({type:'spread',area,stage:batch.stage,at:batch.at,point:'site:'+name,label:name+' 현장',batch:true});
    }
  }
  for(const r of list)if(r.type!=='areaBatch')add(r);
  return expanded;
}
function save(record) {
  const k=record.type==='areaBatch'?'all:'+record.at+':'+record.stage:crypto.randomUUID();
  if(demo) demoStore.set(k,record); else localStorage.setItem(prefix+k,JSON.stringify(record));
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
  if(evidence.surface==='wet' && Number.isFinite(evidence.air) && evidence.air<=4) return '재살포 조건 충족';
  return '현장 확인 필요';
}
function siteEvidence(task,records,trip,li) {
  const s=observations.find(r=>r.stnId===task.point);
  const options=[];
  if(s) options.push({time:readTime(s.time),air:s.temp,surface:({1:'dry',2:'wet',3:'wet'})[s.surfaceCode],source:s.name});
  for(const r of records) if(r.type==='field' && r.trip===trip.id && r.leg===li && r.point===task.point && r.at<=now()){
    options.push({time:r.at,air:r.air,surface:r.surface,source:'현장 확인'});
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
  cards.sort((a,b)=>a.next-b.next);
  $('cards').replaceChildren(...(cards.length?cards.map(r=>r.card):[node('p','차량을 출발시키면 이곳에 점검 시각과 해당 구간의 기상이 표시됩니다.','empty')]));
}
function seedDemo() {
  demoStore.clear();
  for(const [id,from,to,h] of [['example1',2,3,2],['example2',0,2,3]]) {
    save({type:'trip',id,name:towns[from]+' → '+towns[to],at:Date.parse(demoDay+'T0'+h+':00:00+09:00'),duration:60,legs:legsFor(from,to,'편도')});
  }
}
function demoWeather() {
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
  for(const h of forecasts.find(r=>r.id==='gaya').hours.slice(12,15)) Object.assign(h,{type:'눈',pty:'3',wet:true});
  observations=sections.flatMap((s,idx)=>s.stations.map(([stnId,name])=>({stnId,name,time:new Date(now()).toISOString(),
    temp:idx===0?5:3,roadTemp:idx===0?4:1,surfaceCode:idx===1?1:2,surfaceState:idx===1?'건조':'습윤'})));
  precip=new Map(sections.map(s=>[s.area,{type:'무강수',time:now()}]));
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
  const [fc,obs]=await Promise.allSettled([api('/api/short-term-12?roster=13'),api('/api/road-obs?line=14')]);
  if(seq!==loadSeq||demo)return;
  const issues=[];
  if(fc.status==='fulfilled' && Array.isArray(fc.value.regions)){forecasts=withPreviousHours(fc.value.regions);forecastAt=readTime(fc.value.updatedAt);}
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
  if(hints && hintInput()!==hints.input) clearHints('예보가 바뀌었습니다. 힌트를 켜면 새 자료로 판단합니다.');
  paint();
}
// Retain past forecast slots across the hourly roll so overnight rain can still be traced.
function withPreviousHours(rows) {
  const key='bionda:snow-helper:forecast-history:1',floor=Math.floor(now()/H)*H;
  let previous={};
  try {previous=JSON.parse(localStorage.getItem(key))||{};} catch {}
  const history={};
  const result=rows.map(r=>{
    const kept=new Map();
    for(const h of (Array.isArray(previous[r.id])?previous[r.id]:[])){
      const t=readTime(h.time);
      if(t>=floor-12*H && t<=floor)kept.set(t,h);
    }
    for(const h of r.hours||[])kept.set(readTime(h.time),h);
    const hours=[...kept.values()].sort((a,b)=>readTime(a.time)-readTime(b.time));
    history[r.id]=hours.filter(h=>readTime(h.time)>=floor-12*H && readTime(h.time)<=floor+12*H);
    return {...r,hours};
  });
  try{localStorage.setItem(key,JSON.stringify(history));}catch{}
  return result;
}
function hintInput() {return JSON.stringify(forecasts.map(r=>[r.id,r.hours.map(h=>[h.time,h.temp,h.pty,h.wet,h.snowCm,h.rainMm,h.type])]));}
function clearHints(message='') {hints=null;hintUntil=0;$('hintReason').textContent=message;}
function summary(start,end) {
  const box=$('outlook');box.replaceChildren();
  if(!hints){
    box.append(node('p',forecasts.length?'제설 힌트를 켜면 비가 그친 뒤의 예비살포 시간대와 강설 시 본살포 검토 구간이 표시됩니다.':'시간별예보 수신 대기'));
    return;
  }
  for(const stage of ['예비살포','본살포','노면 확인']){
    const groups=new Map();
    for(const r of forecasts) for(const item of hints.byId.get(r.id)||[]) {
      if(item.stage!==stage || item.last<start || item.at>end)continue;
      const key=item.at+'|'+item.last+'|'+(item.until||'');
      if(!groups.has(key))groups.set(key,{item,rows:[]});
      groups.get(key).rows.push(r);
    }
    if(!groups.size && stage==='노면 확인')continue;
    const card=node('div',null,'outlook-card');card.append(node('strong',stage+(stage==='노면 확인'?'':' 검토')));
    if(!groups.size) {
      const available=forecasts.some(r=>r.hours.some(h=>readTime(h.time)>=start && readTime(h.time)<=end && phase(h)!=='unknown'));
      card.append(node('p',!available?'해당 시간 예보 미수신 · 판단 보류':stage==='본살포'?'이 시간대에 강설·진눈깨비 근거 없음. 차로 적설을 확인하면 본살포를 판단하세요.':'이 시간대에 예비살포 후보를 뒷받침하는 예보가 없습니다.'));
    }else{
      for(const {item,rows} of [...groups.values()].sort((x,y)=>x.item.at-y.item.at)){
        const text=stamp(item.at).slice(-5)+(item.until?'~'+stamp(item.until).slice(-5)+' 전':item.last>item.at?'~'+stamp(item.last).slice(-5):'')+' · '+rows.map(r=>r.name).join(', ');
        const b=button(text,()=>{
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
  const hasCurrent=forecasts.some(r=>r.hours.some(h=>readTime(h.time)===floor));
  const start=(picked||showPast)?floor-6*H:hasCurrent?floor:floor+H;
  const tomorrowEnd=Date.parse(ktime(now()+24*H).slice(0,10)+'T23:00:00+09:00');
  const end=$('range').value==='tomorrow'?tomorrowEnd:((picked||showPast)?floor:start)+(Number($('range').value)-1)*H;
  $('forecastSource').textContent=(demo?'모의 예보':'기상청 예보')+' · 자료 '+stamp(forecastAt)+(hints?' · 비온다 자체 판단 '+stamp(now()+hintUntil-Date.now())+'까지':'');
  $('hints').setAttribute('aria-pressed',String(!!hints));$('hints').textContent=hints?'제설 힌트 끄기':'제설 힌트 켜기';$('hints').disabled=!forecasts.length;
  $('history').setAttribute('aria-pressed',String(showPast));
  summary(floor,end);
  if(!forecasts.length){$('matrix').replaceChildren();return;}
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
    header.append(head);
  }
  const body=table.createTBody();
  for(const r of [...forecasts].sort((a,b)=>(a.routeOrder||0)-(b.routeOrder||0))){
    const row=body.insertRow();row.append(node('th',r.county+' '+r.name));
    const hours=new Map(r.hours.map(h=>[readTime(h.time),h]));
    for(let t=start;t<=end;t+=H){
      const cell=row.insertCell(),h=hours.get(t);
      cell.dataset.area=r.id;cell.dataset.at=t;cell.tabIndex=-1;
      if(h?.wet)cell.classList.add('wet');
      if(Number.isFinite(h?.temp)&&h.temp<=0)cell.classList.add('cold');
      cell.append(node('strong',h?temperature(h.temp):'—'),node('small',h?.type==='없음'?'무강수':h?.type||''));
      if(picked&&t<=floor){
        cell.classList.add('can-place');cell.tabIndex=0;
        cell.setAttribute('aria-label',r.name+' '+stamp(t)+' '+picked+' 시각 선택');
      }
      for(const item of hints?.byId.get(r.id)||[]) if(t>=item.at && t<=item.last){
        const b=button(({예비살포:'🚜',본살포:'❄', '노면 확인':'⌕'})[item.stage]+' '+item.stage+' 검토',()=>explain(r,item));
        b.className='hint '+(item.stage==='본살포'?'main-hint':'');b.title=item.text;b.setAttribute('aria-label',r.name+' '+stamp(t)+' '+item.stage+' 검토');cell.append(b);
      }
      for(const rec of records.filter(e=>e.type==='spread'&&e.area===r.id && e.at>=t&&e.at<t+H&&e.at<=now())){
        cell.append(node('small',(rec.stage==='본살포'?'❄ ':'🚜 ')+rec.stage+' '+stamp(rec.at).slice(-5)+' 완료','actual'));
      }
      for(const rec of recent.filter(e=>e.area===r.id && e.at+THREE>=t && e.at+THREE<t+H)){
        cell.append(node('small','◷ '+stamp(rec.at+THREE).slice(-5)+' 재살포 점검','actual'));
      }
    }
  }
  $('matrix').replaceChildren(table);
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
  $('source').textContent=(demo?'모의 상황':'실시간 시험판')+' · '+stamp(now())+' KST';
  $('feed').textContent=demo?'모의 예보 · 전날 22:56 강우 뒤 하강 / 다음 날 가야면 11~13시 강설 예시':refreshing?'기상 자료를 불러오는 중…':error||'예보 수신 '+stamp(forecastAt)+' · 5분 간격 갱신';
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
    if(previous) Object.assign(record,{area:previous.area,stage:'실제 살포'});
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
  chooseStage('');if(demo&&!demoStore.size)seedDemo();
  refresh();
};
$('refresh').onclick=refresh;$('clock').onchange=()=>{clearHints();refresh();};$('query').oninput=paintRules;$('range').onchange=paintHours;
$('hints').onclick=async()=>{
  if(hints){clearHints();paint();return;}
  const b=$('hints');b.disabled=true;b.textContent='산출 중…';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  $('hintReason').textContent='';
  const byId=new Map(forecasts.map(r=>[r.id,spreadingHints(r.hours,now())]));
  hints={byId,input:hintInput()};hintUntil=Date.now()+10*MIN;b.disabled=false;paint();
};
let showPast=false;
const palette=$('tools'),grid=$('matrix');
const stages=['예비살포','본살포'];
function chooseStage(stage) {
  picked=stage;
  for(const b of palette.querySelectorAll('[data-stage]'))b.setAttribute('aria-pressed',String(stage===b.dataset.stage));
  $('placement').textContent=stage?stage+' · 맨 위 시간은 전 구간, 지역 칸은 한 곳을 선택합니다.':'아이콘을 놓거나 선택 후 눌러 주세요. 맨 위 시간은 전 구간, 지역 칸은 한 곳에 반영합니다.';
  if(screen==='hours')paintHours();
}
function openGridTime(cell) {
  if(!picked||!cell)return;
  const t=Number(cell.dataset.at);
  if(t>now()){$('placement').textContent='미래 시간에는 실제 살포를 표시할 수 없습니다.';return;}
  const all=cell.tagName==='TH';
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
function quickDue(){
  const at=inputMs('quickTime');
  $('quickDue').textContent=Number.isFinite(at)?'재살포 점검 '+stamp(at+THREE):'실제 살포한 분을 선택하세요.';
}
$('quickTime').oninput=quickDue;
$('quickForm').onsubmit=e=>{
  e.preventDefault();const at=inputMs('quickTime'),q=quickTarget;
  if(!q||at<q.t||at>=q.t+H||!Number.isFinite(at)||at>now())return;
  if(q.all){
    try {save({type:'areaBatch',stage:q.stage,at,areas:[...regions.keys()]});}
    catch {$('quickError').textContent='전 구간 입력을 저장하지 못했습니다.';return;}
    $('quick').close();showPast=true;chooseStage('');
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
  $('quick').close();showPast=true;chooseStage('');
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
$('history').onclick=()=>{showPast=!showPast;chooseStage('');};
let lastMinute=Math.floor(now()/MIN);
setInterval(()=>{
  if(document.hidden)return;
  const m=Math.floor(now()/MIN);
  if(lastMinute!==m || (hints && Date.now()>=hintUntil)){lastMinute=m;paint();}
},1000);
let fetched=0;
function scheduled(){if(!demo&&!document.hidden&&!refreshing && Date.now()-fetched>=5*MIN){fetched=Date.now();refresh();}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){paint();scheduled();}});
window.addEventListener('storage',e=>{if(e.key?.startsWith(prefix)&&!demo)paint();});
setInterval(scheduled,30000);
scheduled();
})();
