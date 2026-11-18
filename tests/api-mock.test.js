const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.KMA_SERVICE_KEY='dummy-do-not-expose';
const {forecast}=require('../server');
const pad=x=>String(x).padStart(2,'0');
const nowKst=new Date(Date.now()+9*3600000);nowKst.setUTCMinutes(0,0,0);
function item(date,i,category,fcstValue){return {fcstDate:`${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}`,fcstTime:`${pad(date.getUTCHours())}00`,category,fcstValue};}
function contentFor(resource){
  const items=[];
  if(resource==='getUltraSrtNcst'){
    return [{category:'PTY',obsrValue:'0'},{category:'RN1',obsrValue:'0'},{category:'T1H',obsrValue:'15'}];
  }
  for(let i=1;i<= (resource==='getUltraSrtFcst'?6:12);i++){
    const date=new Date(nowKst.getTime()+i*3600000);
    items.push(item(date,i,'PTY',i>=2&&i<=4?'1':'0'));
    items.push(item(date,i,'POP',i>=2&&i<=4?'80':'20'));
    items.push(item(date,i,resource==='getUltraSrtFcst'?'RN1':'PCP',i>=2&&i<=4?'1mm':'강수없음'));
    items.push(item(date,i,resource==='getUltraSrtFcst'?'T1H':'TMP','15'));
  }
  return items;
}
test('서버 프록시의 실황·초단기·단기 병합과 종료 분석은 수치 데이터만 반환한다',async()=>{
  const before=global.fetch;
  global.fetch=async input=>{
    const u=new URL(input);
    assert.equal(u.searchParams.get('serviceKey'),'dummy-do-not-expose');
    const resource=u.pathname.split('/').at(-1);
    return {ok:true,status:200,text:async()=>JSON.stringify({response:{header:{resultCode:'00',resultMsg:'NORMAL_SERVICE'},body:{items:{item:contentFor(resource)}}}})};
  };
  try {
    const result=await forecast(36.3504,127.3845);
    assert.equal(result.ok,true);
    assert.equal(result.hours.length,12);
    assert.equal(result.analysis.start.time,result.hours[1].time);
    assert.equal(result.analysis.end.time,result.hours[4].time);
    assert.equal(result.analysis.horizons[0].hasPrecipitation,true);
    assert.equal(result.analysis.horizons[2].hasPrecipitation,true);
    assert.ok(!JSON.stringify(result).includes('dummy-do-not-expose'));
    assert.ok(!JSON.stringify(result).includes('serviceKey'));
  } finally { global.fetch=before; }
});
