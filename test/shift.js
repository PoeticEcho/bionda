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
let demo=false, screen='shift', selected=null, refreshing=false, loadSeq=0, error='';
let observations=[], forecasts=[], precip=new Map(), forecastAt=NaN;
let hints=null, hintUntil=0;
const now=()=>demo?Date.parse(demoDay+'T'+$('clock').value+':00+09:00'):Date.now();
const prefix='bionda:snow-helper:test:1:';
let demoStore=new Map();
function entries() {
  if (demo) return [...demoStore.values()];
  const list=[];
  try {
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(!k?.startsWith(prefix)) continue;
      try { const r=JSON.parse(localStorage.getItem(k)); if(r?.type) list.push(r); } catch {}
    }
  } catch {error='이 기기에서 저장소를 사용할 수 없습니다.';}
  return list;
}
function save(record) {
  const k=crypto.randomUUID();
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
  observations=sections.flatMap((s,idx)=>s.stations.map(([stnId,name])=>({stnId,name,time:new Date(now()).toISOString(),
    temp:idx===0?5:3,roadTemp:idx===0?4:1,surfaceCode:idx===1?1:2,surfaceState:idx===1?'건조':'습윤'})));
  precip=new Map(sections.map(s=>[s.area,{type:'무강수',time:now()}]));
  forecastAt=start-H/2;
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
  if(hints && hintInput()!==hints.input) clearHints();
  paint();
}
function hintInput() {return JSON.stringify(forecasts.map(r=>[r.id,r.hours.map(h=>[h.time,h.temp,h.pty,h.wet,h.snowCm,h.rainMm,h.type])]));}
function clearHints() {hints=null;hintUntil=0;$('hintReason').textContent='';}
function paintHours() {
  const start=Math.floor(now()/H)*H;
  const tomorrowEnd=Date.parse(ktime(now()+24*H).slice(0,10)+'T23:00:00+09:00');
  const end=$('range').value==='tomorrow'?tomorrowEnd:start+(Number($('range').value)-1)*H;
  $('forecastSource').textContent=(demo?'모의 예보':'기상청 예보')+' · 자료 '+stamp(forecastAt)+(hints?' · 비온다 자체 힌트 '+stamp(hintUntil)+'까지':'');
  $('hints').setAttribute('aria-pressed',String(!!hints));$('hints').textContent=hints?'제설 힌트 끄기':'제설 힌트 켜기';
  if(!forecasts.length){$('matrix').textContent='시간별예보 수신 대기';return;}
  const table=node('table'),header=table.createTHead().insertRow();
  header.append(node('th','지역'));
  for(let t=start;t<=end;t+=H) header.append(node('th',stamp(t)));
  const body=table.createTBody();
  for(const r of [...forecasts].sort((a,b)=>(a.routeOrder||0)-(b.routeOrder||0))){
    const row=body.insertRow();row.append(node('th',r.county+' '+r.name));
    const hours=new Map(r.hours.map(h=>[readTime(h.time),h]));
    for(let t=start;t<=end;t+=H){
      const cell=row.insertCell(),h=hours.get(t);
      if(!h){cell.textContent='—';continue;}
      if(h.wet)cell.classList.add('wet');if(Number.isFinite(h.temp)&&h.temp<=0)cell.classList.add('cold');
      cell.append(node('strong',temperature(h.temp)),node('small',h.type==='없음'?'무강수':h.type||'미수신'));
      for(const w of hints?.byId.get(r.id)||[]) if(w.at===t && w.mode!=='rain'){
        const label={candidate:'🚜 살포 후보',inspect:'⌕ 노면 확인',rainPatrol:'⌕ 순찰 확인',snow:'🚜 강설 준비',freezingRain:'어는비 확인'}[w.mode];
        const b=button(label,()=>{$('hintReason').textContent=r.name+' '+stamp(t)+' · '+timingAdvice(w.mode);$('hintReason').scrollIntoView({block:'nearest'});});b.className='hint';cell.append(b);
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
  if(hints&&Date.now()>=hintUntil)clearHints();
  $('source').textContent=(demo?'모의 상황':'실시간 시험판')+' · '+stamp(now())+' KST';
  $('feed').textContent=demo?'11월 24일 모의 기상 · 출발 예시 02시 고령 → 화원, 03시 함양 → 고령':refreshing?'기상 자료를 불러오는 중…':error||'예보 수신 '+stamp(forecastAt)+' · 5분 간격 갱신';
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
  if(demo&&!demoStore.size)seedDemo();
  refresh();
};
$('refresh').onclick=refresh;$('clock').onchange=()=>{clearHints();refresh();};$('query').oninput=paintRules;$('range').onchange=paintHours;
$('hints').onclick=async()=>{
  if(hints){clearHints();paint();return;}
  const b=$('hints');b.disabled=true;b.textContent='산출 중…';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const byId=new Map(forecasts.map(r=>[r.id,snowWindows(r.hours,now(),48)]));
  hints={byId,input:hintInput()};hintUntil=Date.now()+10*MIN;b.disabled=false;paint();
};
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
