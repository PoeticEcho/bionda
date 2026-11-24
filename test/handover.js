// Shared records live on the test Worker. Device-only entries are never uploaded implicitly.
class ShiftHandover {
  constructor(onChange) {
    this.base='https://bionda-shift.herego.workers.dev';
    this.key='bionda:shift:outbox:';
    this.remote=new Map();
    this.onChange=onChange;
    this.message='';
    try { this.token=sessionStorage.getItem('bionda:shift:session')||''; } catch { this.token=''; }
  }
  async request(path,options={}) {
    const res=await fetch(this.base+path,{...options,signal:AbortSignal.timeout(10000),
      headers:{...(path==='/operations'?{Authorization:'Bearer '+this.token}:{}),...options.headers}});
    if(!res.ok) throw Object.assign(Error('HTTP '+res.status),{status:res.status});
    return res.json();
  }
  pending() {
    const rows=[];
    try {
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);
      if(key?.startsWith(this.key)) rows.push(JSON.parse(localStorage.getItem(key)));
    }
    } catch {this.message='이 기기의 저장소 이용 불가';}
    return rows;
  }
  list() {
    const rows=new Map(this.token?this.remote:[]);
    for(const item of this.pending()) rows.set(item.id,item);
    return [...rows.values()].map(({id,record})=>({...record,sharedId:id}));
  }
  enqueue(record,id=crypto.randomUUID(),expectedRevision) {
    const previous=this.pending().find(r=>r.id===id)||this.remote.get(id);
    const {sharedId,localKey,...value}=record;
    const entry={id,revision:expectedRevision??previous?.revision??0,record:value};
    localStorage.setItem(this.key+id,JSON.stringify(entry));
    this.sync();
    return id;
  }
  async login(token) {
    this.generation=(this.generation||0)+1;
    this.token=token.trim(); this.remote.clear(); this.message='';
    if(this.token) sessionStorage.setItem('bionda:shift:session',this.token);
    else sessionStorage.removeItem('bionda:shift:session');
    await this.sync();
    this.onChange();
  }
  async sync() {
    if(!this.token) return;
    if(this.running){this.again=true;return;}
    this.running=true;
    const generation=this.generation;
    try {
      const latest=await this.request('/operations');
      if(generation!==this.generation)return;
      this.remote=new Map(latest.map(r=>[r.id,r]));
      this.message='';
      for(const item of this.pending()){
        if(generation!==this.generation)break;
        const k=this.key+item.id;
        try {
          const {revision}=await this.request('/operations',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(item)});
          if(generation!==this.generation)break;
          this.remote.set(item.id,{...item,revision});
          if(localStorage.getItem(k)===JSON.stringify(item)) localStorage.removeItem(k);
          else {
            const newer=localStorage.getItem(k);
            if(newer)localStorage.setItem(k,JSON.stringify({...JSON.parse(newer),revision}));
            this.again=true;
          }
        } catch(e) {
          if(e.status===409){this.message='수정 충돌 · 공유 대기 항목을 선택해 최신 기록을 확인하세요.';continue;}
          throw e;
        }
      }
    } catch(e) {this.message=e.status===401?'인계 코드 확인 필요':'근무 인계 연결 지연';}
    finally {
      this.running=false;this.onChange();
      if(this.again){this.again=false;this.sync();}
    }
  }
}
