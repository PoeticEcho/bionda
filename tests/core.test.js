const { test } = require('node:test');
const assert = require('node:assert/strict');
const {latlonToGrid,baseUltra,baseShort,baseObservation,analyze,server}=require('../server');

test('서울 기상청 DFS 격자 변환',()=>assert.deepEqual(latlonToGrid(37.5665,126.9780),{nx:60,ny:127}));
test('대전 기상청 DFS 격자 변환',()=>assert.deepEqual(latlonToGrid(36.3504,127.3845),{nx:67,ny:100}));
test('초단기 발표시각 선택',()=>{
  const d=Date.parse('2026-11-18T14:46:00+09:00');
  assert.equal(baseUltra(d).getUTCHours(),14); assert.equal(baseUltra(d).getUTCMinutes(),30);
  const earlier=Date.parse('2026-11-18T14:29:00+09:00');
  assert.equal(baseUltra(earlier).getUTCHours(),13);
});
test('단기 발표시각 20분 안전 지연',()=>{
  assert.equal(baseShort(Date.parse('2026-11-18T14:10:00+09:00')).getUTCHours(),11);
  assert.equal(baseShort(Date.parse('2026-11-18T14:40:00+09:00')).getUTCHours(),14);
});
test('연속 2시간 무강수 시 종료 후보 계산',()=>{
  const hours=Array.from({length:12},(_,i)=>({offset:i+1,wet:i>=1&&i<=3,risk:false,type:i>=1&&i<=3?'비':'없음',chance:0,time:new Date(Date.parse('2026-11-18T14:00:00+09:00')+(i+1)*3600000).toISOString()}));
  const a=analyze(hours,{wet:false});assert.ok(a.start);assert.ok(a.end);assert.equal(a.end.rule,'연속 2시간 무강수 예보');
});
test('12시간 동안 강수 지속이면 종료시각은 미확정',()=>{
  const hours=Array.from({length:12},(_,i)=>({offset:i+1,wet:true,risk:false,type:'비',chance:90,time:new Date(Date.parse('2026-11-18T14:00:00+09:00')+(i+1)*3600000).toISOString()}));
  const a=analyze(hours,{wet:true});assert.equal(a.end,null);assert.equal(a.extendsBeyondWindow,true);
});
