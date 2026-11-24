const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

const root=path.join(__dirname,'..');
const H=3600000, time=Date.parse('2026-11-24T05:00:00+09:00');
function database(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(root,'cloudflare/shift/migrations/0001_shift.sql'),'utf8'));
  function prepare(sql,values=[]){
    const query=sqlite.prepare(sql);
    return {bind:(...v)=>prepare(sql,v),run:()=>({meta:query.run(...values)}),
      all:()=>({results:query.all(...values)}),first:()=>query.get(...values)};
  }
  return {prepare,batch:ops=>ops.map(q=>q.run())};
}
function storage(){
  const data=new Map();
  return {get length(){return data.size;},key:i=>Array.from(data.keys())[i],getItem:k=>data.get(k)??null,
    setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
}
async function backend(){
  const {handler}=await import('../cloudflare/shift/worker.mjs');
  const env={DB:database(),SHIFT_TEAM_TOKEN:'fixture-only'};
  return {env,call:(path,options={})=>handler(new Request('https://worker.example'+path,options),env,time)};
}
test('separate devices inherit a minute-accurate operation, retry once, and resolve competing revisions',async()=>{
  const {call}=await backend();
  const makeDevice=()=>{
    const ctx=vm.createContext({localStorage:storage(),sessionStorage:storage(),crypto,AbortSignal,
      fetch:(url,opts)=>call(new URL(url).pathname,opts)});
    vm.runInContext(fs.readFileSync(path.join(root,'test/handover.js'),'utf8'),ctx);
    return vm.runInContext('new ShiftHandover(()=>{})',ctx);
  };
  const first=makeDevice(),next=makeDevice();
  for(const device of [first,next])await device.login('fixture-only');
  const at=Date.parse('2026-11-24T02:10:00+09:00');
  const rec={type:'spread',stage:'예비살포',at,area:'seongsan',point:'site:성산면',label:'성산면'};
  const id=first.enqueue(rec);
  while(first.running)await new Promise(r=>setImmediate(r));
  await next.sync();
  assert.equal(next.list().length,1);
  assert.equal(next.list()[0].at+3*H,Date.parse('2026-11-24T05:10:00+09:00'));
  const put=(record,revision)=>call('/operations',{method:'PUT',headers:{Authorization:'Bearer fixture-only'},
    body:JSON.stringify({id,record,revision})});
  assert.equal((await put(rec,0)).status,200);
  assert.equal((await put({...rec,at:at+60000},1)).status,200);
  assert.equal((await put({...rec,at:at+120000},1)).status,409);
  await next.sync();
  assert.equal(next.list()[0].at,at+60000);
  assert.equal((await call('/operations')).status,401);
  assert.equal((await put({...rec,at:time+1},2)).status,400);
  await next.login('');
  assert.equal(next.list().length,0);
});
test('hourly collector stores each actual source time, a missing PTY stays unknown, repeat runs do not duplicate observations',async()=>{
  const {collect}=await import('../cloudflare/shift/worker.mjs');
  const {env,call}=await backend(); env.KMA_SERVICE_KEY='test-only';
  const at=time+40*60000, realFetch=global.fetch, grids=new Set();
  global.fetch=async input=>{
    const u=new URL(input);
    if(u.pathname==='/api/road-obs')return Response.json({stations:[{stnId:'14209',time:new Date(at-60000).toISOString(),roadTemp:1.8,surfaceState:'습윤'}]});
    const nx=u.searchParams.get('nx'),ny=u.searchParams.get('ny');
    grids.add(nx+','+ny);
    const baseDate=u.searchParams.get('base_date'),baseTime=u.searchParams.get('base_time');
    return Response.json({response:{header:{resultCode:'00'},body:{items:{item:[{category:'T1H',obsrValue:'3',baseDate,baseTime,nx,ny}]}}}});
  };
  try {await collect(env,at);await collect(env,at);} finally {global.fetch=realFetch;}
  const rows=await (await call('/history')).json();
  assert.equal(rows.length,13);assert.ok(grids.size<=13);
  assert.ok(rows.every(r=>r.temp===3 && r.wet===null && r.type===null && Date.parse(r.time)===time));
  const roads=await env.DB.prepare("SELECT * FROM weather WHERE kind='station'").all();
  assert.equal(roads.results.length,1);
  assert.equal(roads.results[0].at,at-60000);
});
