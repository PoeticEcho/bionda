const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {join}=require('node:path');
const rules=vm.createContext({});
vm.runInContext(fs.readFileSync(join(__dirname,'../test/rain-windows.js'),'utf8'),rules);
const H=3600000;
const base=Date.parse('2026-11-23T23:00:00+09:00');
function hours(temps,types) {
  return temps.map((temp,i)=>({time:new Date(base+i*H).toISOString(),temp,type:types[i]||'없음',pty:'0'}));
}
test('Pages warns throughout the dry pre-treatment interval, including late overnight cooling',()=>{
  for(const [temps,types,first,cold] of [
    [[8,8,8,7,7,6,4,4],['비','빗방울'],2,6],
    [[8,8,8,8,7,6,5,4],['비'],1,7]
  ]){
    const signals=rules.spreadingHints(hours(temps,types),base);
    const pre=signals.find(w=>w.stage==='예비살포');
    assert.equal(pre.at,base+first*H);
    assert.equal(pre.last,base+(cold-1)*H);
    assert.equal(pre.until,base+cold*H);
    assert.ok(!signals.some(w=>w.stage==='본살포'));
  }
});
test('Pages separates snowfall onset and lane accumulation checks from liquid rain or dry freezing',()=>{
  const snow=rules.spreadingHints(hours([4,2,1,0],['비','눈','진눈깨비']),base);
  assert.ok(snow.some(w=>w.stage==='예비살포'&&w.at===base&&w.onset===base+H));
  assert.ok(snow.some(w=>w.label==='차로 적설 확인'&&w.at===base+H&&w.last===base+2*H));
  assert.ok(!snow.some(w=>w.stage==='본살포'));
  const cold=rules.spreadingHints(hours([4,0,-1],[]),base);
  assert.ok(cold.some(w=>w.stage==='노면 확인'));
  assert.ok(cold.every(w=>w.stage==='노면 확인'));
});
