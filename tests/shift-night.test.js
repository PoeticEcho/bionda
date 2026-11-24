const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SHORT_TERM_12_REGIONS}=require('../lib/bionda-core.js');
const when=t=>Date.parse(t+'+09:00');
test('night archive uses KST start date, original sample times and one request per grid',async()=>{
  const {sample,shiftDate,merge}=await import('../scripts/shift-night.mjs');
  const end=when('2026-11-25T10:00:00');
  assert.equal(shiftDate(end),'2026-11-24');
  assert.equal(shiftDate(when('2026-11-25T18:00:00')),'2026-11-25');
  let queries=0;
  const out=await sample(end+40*60000,async url=>{
    if(url.startsWith('/api/road-obs'))return {stations:[
      {stnId:'14209',time:new Date(end).toISOString(),roadTemp:0},
      {stnId:'late',time:new Date(end+60000).toISOString(),roadTemp:2}]};
    if(url.startsWith('/api/short-term'))return {regions:[],updatedAt:new Date(end).toISOString()};
    queries++;
    return {analysis:{now:{time:new Date(end).toISOString(),temp:'0',type:'비',wet:true}}};
  });
  assert.equal(queries,new Set(SHORT_TERM_12_REGIONS.map(r=>JSON.stringify(r.grid))).size);
  assert.equal(out.observations.length,14);assert.equal(out.observations.some(r=>r.id==='late'),false);
  assert.equal(merge(merge(null,out),out).observations.length,14);
});
test('match distinguishes departure, fresh observations and forecasts actually available to the duty officer',async()=>{
  const {compare}=await import('../scripts/shift-night.mjs');
  const at='2026-11-25T02:10:00+09:00', t=Date.parse(at), H=3600000;
  const obs=(kind,id,ms)=>({kind,id,time:new Date(ms).toISOString(),temp:2});
  const rows=[{id:'seongsan',hours:[{time:'2026-11-25T02:00:00+09:00',temp:2}]}];
  const ed=n=>({capturedAt:new Date(t+n).toISOString(),updatedAt:new Date(t-2*H).toISOString(),regions:rows});
  const report=compare({night:'2026-11-24',observations:[obs('area','seongsan',t-600000),obs('station','14209',t-H)],editions:[ed(-60000),ed(60000)]},
    [{at,section:'고령 ↔ 화원',areaId:'seongsan',stationId:'14209',basis:'departure'}],t+4*H)[0];
  assert.equal(report.atWork.station,null);assert.equal(report.atWork.area.temp,2);
  assert.equal(report.atWork.forecast.capturedAt,ed(-60000).capturedAt);
  assert.equal(report.checkKind,'출발 후 기상 점검');assert.equal(report.atCheck.area,null);
});
test('delayed grid readings stay in their measured hour and do not count as latest coverage',async()=>{
  const {sample}=await import('../scripts/shift-night.mjs');
  const at=when('2026-11-25T02:40:00'), time=new Date(at-160*60000).toISOString();
  const data=await sample(at,async url=>{
    if(url.includes('short-term'))return {updatedAt:new Date(at).toISOString(),regions:[]};
    if(url.includes('road-obs'))return {stations:[{stnId:'14209',time:new Date(at).toISOString()}]};
    if(url.includes('&edition='))throw Error('timeout');
    return {analysis:{now:{time,temp:3,type:'비',wet:true}}};
  });
  assert.equal(data.received.areas,0);assert.equal(data.received.stations,1);
  assert.equal(data.delayed.flatMap(x=>x.areas).length,13);
  assert.ok(data.observations.filter(r=>r.kind==='area').every(r=>r.time===time));
});
