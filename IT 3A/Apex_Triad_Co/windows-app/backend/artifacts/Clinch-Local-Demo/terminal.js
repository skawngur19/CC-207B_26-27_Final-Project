(() => {
'use strict';
const encoder = new TextEncoder(), decoder = new TextDecoder();
const storage = globalThis.ClinchTerminalStorage;
const bridge = 'http://127.0.0.1:8765/v1/';
const bytes = string => Uint8Array.from(atob(string), char => char.charCodeAt(0));
const base64 = array => btoa(Array.from(new Uint8Array(array), byte => String.fromCharCode(byte)).join(''));
const hex = array => Array.from(new Uint8Array(array), byte => byte.toString(16).padStart(2,'0')).join('');
const isStaff = user => ['owner','employee'].includes(user?.role);
const time = value => Date.parse(value);
const shiftDate = ms => new Date(ms + 8*3600000).toISOString().slice(0,10);
const request = (...args) => globalThis.ClinchApi.api(...args);

function validLease(active, now = Date.now()) {
  return !!active && isStaff(active.user) && Number.isFinite(active.anchor) &&
    now + 30000 >= active.anchor && now < active.until;
}
function grantClaims(token) {
  try {
    const raw=token.split('.')[0].replaceAll('-','+').replaceAll('_','/');
    return JSON.parse(decoder.decode(bytes(raw)));
  } catch { throw new Error('The terminal grant could not be read.'); }
}
async function keys(secret) {
  if (!secret || secret.length < 24 || secret.length > 256) throw new Error('Paste the pairing key from the Windows app.');
  const raw = encoder.encode(secret);
  return {
    hmac:await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['verify']),
    aes:await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',raw),'AES-GCM',false,['encrypt','decrypt'])
  };
}
async function localRequest(path, body) {
  const response = await fetch(bridge+path, {method:body?'POST':'GET',mode:'cors',cache:'no-store',
    credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(2500),
    ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  if (!response.ok) throw new Error('Windows engine unavailable.');
  return response.json();
}
async function identify(pair) {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(24)));
  const info = await localRequest('hello?'+new URLSearchParams({nonce,operatorId:pair.operatorId}));
  if (info.mode !== 'connected' || info.operatorId !== pair.operatorId || typeof info.terminalId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(info.terminalId) || !/^[a-f0-9]{64}$/.test(info.proof) ||
      (pair.terminalId && pair.terminalId !== info.terminalId)) throw new Error('Windows engine identity does not match this pairing.');
  const proof = Uint8Array.from(info.proof.match(/../g),v => parseInt(v,16));
  const challenge = encoder.encode(['clinch-bridge-v1',nonce,info.terminalId,pair.operatorId,'connected'].join(':'));
  if (!await crypto.subtle.verify('HMAC',pair.hmac,proof,challenge)) throw new Error('Check the pairing key in the Windows app.');
  return info.terminalId;
}
async function forward(pair, row) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode('clinch-bridge-v1:'+pair.operatorId);
  const ivText = base64(iv);
  const envelope = encoder.encode(JSON.stringify({grant:row.grant,receipt:row.receipt}));
  const box = base64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},pair.aes,envelope));
  const reply = await localRequest('receipts',{operatorId:pair.operatorId,iv:ivText,box});
  if (reply.operatorId !== pair.operatorId || typeof reply.box !== 'string' || reply.box.length>65536 ||
      typeof reply.iv !== 'string' || bytes(reply.iv).length !== 12) throw new Error('Unrecognized engine response.');
  const content = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(reply.iv),additionalData},pair.aes,bytes(reply.box));
  const ack = JSON.parse(decoder.decode(content));
  if (!ack.durable || ack.nonce !== ivText || ack.receiptId !== row.id ||
      !['accepted','pending','conflict'].includes(ack.status)) throw new Error('Windows acknowledgment could not be verified.');
  return ack.status;
}
function minimalSnapshot(s) {
  // The offline cashier needs catalog and unpaid booking prices, not personnel or audit files.
  return {user:s.user,revision:s.revision,serverTime:s.serverTime,demo:s.demo,products:s.products,
    bookings:s.bookings.filter(b => !b.paid && b.status !== 'cancelled').map(b => ({
      id:b.id,reference:b.reference,resourceId:b.resourceId,customerName:b.customerName,
      date:b.date,startHour:b.startHour,endHour:b.endHour,total:b.total,status:b.status,paid:false,version:b.version})),
    resources:s.resources,jobs:[],sales:[],applications:[],employees:[],audit:[]};
}
function uniqueSales(s) { return new Set((s.sales || []).map(sale => sale.operationId).filter(Boolean)); }
function project(s, rows) {
  if (!rows.length) return s;
  const posted = new Set([...uniqueSales(s),...(s.postedTerminalIds||[])]);
  const held = new Map(), bookings = new Set();
  for (const row of rows) {
    if (posted.has(row.id)) continue;
    for (const item of row.receipt.items) held.set(item.productId,(held.get(item.productId)||0)+item.quantity);
    if (row.receipt.bookingId) bookings.add(row.receipt.bookingId);
  }
  return {...s,products:s.products.map(p => ({...p,stock:Math.max(0,p.stock-(held.get(p.id)||0))})),
    bookings:s.bookings.map(b => bookings.has(b.id)?{...b,paid:true}:b)};
}
function prepareSale(active, snapshot, rows, body, sequence, now) {
  if (!validLease(active,now)) throw new Error('Offline authorization expired or the clock changed. Reconnect and sign in.');
  const available = project(snapshot,rows);
  if (!Array.isArray(body.items) || body.items.length>30 || body.method !== 'cash') throw new Error('Invalid cash order.');
  const seen = new Set();
  let total = 0;
  const items = body.items.map(({productId,quantity,unitPrice}) => {
    const p = available.products.find(p => p.id === productId);
    if (!p || seen.has(productId) || p.price !== unitPrice || !Number.isInteger(quantity) ||
        quantity<1 || quantity>100 || quantity>p.stock) throw new Error('Price or stock changed. Review your order before taking cash.');
    seen.add(productId); total += p.price*quantity;
    return {productId,quantity,unitPrice:p.price};
  });
  const receipt={operationId:body.operationId,operatorId:active.user.id,terminalId:active.terminalId,sequence,
    shiftId:active.shiftId,occurredAt:new Date(now).toISOString(),catalogVersion:snapshot.revision,items,method:'cash',tendered:body.tendered};
  if (body.bookingId) {
    const b = available.bookings.find(b => b.id === body.bookingId);
    if (!b || b.paid || b.status==='cancelled' || b.version!==body.bookingVersion || b.total!==body.bookingTotal)
      throw new Error('Reservation payment changed. Refresh before taking cash.');
    total += b.total;
    Object.assign(receipt,{bookingId:b.id,bookingVersion:b.version,bookingTotal:b.total});
  }
  if (!Number.isSafeInteger(total) || total<=0 || !Number.isSafeInteger(body.tendered) ||
      body.tendered<total || body.tendered>100000000) throw new Error('Check cash received before recording the order.');
  return {id:receipt.operationId,operatorId:receipt.operatorId,grant:active.grant,receipt,total,status:'browser',
    lines:items.map(item => ({...item,name:available.products.find(p => p.id===item.productId).name})).concat(
      receipt.bookingId?[{name:'Study time',quantity:1,unitPrice:receipt.bookingTotal}]:[])};
}

class Terminal {
  constructor(onChange) { this.onChange=onChange; this.rows=[]; this.holds=[]; this.generation=0; }
  get enabled() { return !!this.pair; }
  async login(session) {
    const generation=++this.generation;
    this.session=session; this.pair=null; this.active=null; this.rows=[]; this.holds=[]; this.lastSnapshot=null;
    if (globalThis.ClinchApi.localDemo || !globalThis.indexedDB) return;
    const pair=isStaff(session?.user)?await storage.read('pair:'+session.user.id):null;
    if (this.generation!==generation) return;
    await storage.locked(async db => {
      const last=await db.get('active');
      if (last?.user.id !== session?.user?.id || last?.until !== time(session?.expiresAt) || !pair) await db.del('active');
    });
    if (!pair || this.generation!==generation) return;
    this.pair=pair;
    this.rows=await storage.list(session.user.id);
    const last=await storage.read('active');
    if (this.generation!==generation) return;
    if (last?.terminalId===pair.terminalId && last.user.id===session.user.id && validLease(last)) this.active=last;
  }
  async authorize() {
    const pair=this.pair, session=this.session, generation=this.generation;
    if (!pair || !session || !isStaff(session.user)) return;
    const data=await request('/terminal/grant?terminalId='+encodeURIComponent(pair.terminalId));
    const claims=grantClaims(data.grant);
    if (claims.userId!==session.user.id || claims.role!==session.user.role ||
        claims.terminalId!==pair.terminalId || claims.publicOrigin!==location.origin || claims.expiresAt!==data.expiresAt)
      throw new Error('The terminal grant belongs to a different session or origin.');
    const now=Date.now(), until=Math.min(time(session.expiresAt),time(data.expiresAt));
    if (!data.grant || !Number.isFinite(until) || until<=now || this.generation!==generation)
      throw new Error('The terminal authorization is unavailable. Sign in again.');
    const active={user:session.user,grant:data.grant,until,anchor:now,terminalId:pair.terminalId,
      shiftId:pair.terminalId+'-'+shiftDate(now),snapshot:null};
    await storage.locked(async db => {
      if (this.generation!==generation) throw new Error('The signed-in cashier changed.');
      const previous=await db.get('active');
      if (previous?.user.id===active.user.id && previous.terminalId===active.terminalId) active.snapshot=previous.snapshot;
      if(Number.isSafeInteger(data.lastSequence)&&data.lastSequence>=0){
        const key='sequence:'+pair.terminalId;
        await db.put(key,Math.max(await db.get(key)||0,data.lastSequence));
      }
      await db.put('active',active);
    });
    this.active=active;
  }
  async pairWith(secret) {
    const user=this.session?.user;
    if (!isStaff(user)) throw new Error('Sign in online as staff to pair a terminal.');
    const pair={operatorId:user.id,...await keys(secret.trim())};
    pair.terminalId=await identify(pair);
    if (this.rows.some(r => r.receipt.terminalId!==pair.terminalId)) throw new Error('Finish syncing this terminal before pairing another engine.');
    await storage.write('pair:'+user.id,pair);
    this.pair=pair;
    await this.authorize();
    await navigator.storage?.persist?.().catch(() => {});
  }
  async restore() {
    if (globalThis.ClinchApi.localDemo || !globalThis.indexedDB) return null;
    const active=await storage.read('active');
    if (!validLease(active) || !active.snapshot) return null;
    const pair=await storage.read('pair:'+active.user.id);
    if (!pair || pair.terminalId!==active.terminalId) return null;
    this.pair=pair; this.active=active; this.session={user:active.user,expiresAt:new Date(active.until).toISOString()};
    this.lastSnapshot=active.snapshot;
    this.holds=await storage.locked(db=>db.terminal(active.terminalId));
    this.rows=this.holds.filter(r=>r.operatorId===active.user.id);
    return {user:active.user,snapshot:project(active.snapshot,this.holds)};
  }
  async update(snapshot) {
    if (!this.enabled || this.session?.user.id!==snapshot.user.id) return snapshot;
    const pair=this.pair;
    // /session can refresh after an outage without extending the signed authorization.
    if (!this.active || this.active.until < Math.min(Date.now()+60000,time(this.session.expiresAt)-1000)) await this.authorize();
    this.lastSnapshot=snapshot;
    const included=uniqueSales(snapshot), resolved=new Set(snapshot.resolvedTerminalIds||[]);
    for(const id of resolved) included.add(id);
    await storage.locked(async db => {
      const a=await db.get('active');
      if (!a || a.user.id!==snapshot.user.id || a.terminalId!==pair.terminalId) throw new Error('Sign in to authorize this terminal.');
      if(a.snapshot?.revision>snapshot.revision) return;
      this.holds=await db.terminal(pair.terminalId);
      const changed=a.snapshot?.revision!==snapshot.revision || !a.snapshot;
      if (changed || Date.now()-a.anchor>60000) {
        a.anchor=Math.max(a.anchor,Date.now(),time(snapshot.serverTime));
        if (changed) a.snapshot={...minimalSnapshot(snapshot),postedTerminalIds:this.holds.filter(r=>included.has(r.id)).map(r=>r.id)};
        await db.put('active',a);
      }
      this.active=a;
      for (const row of this.holds) {
        if (included.has(row.id) && (row.engineSaved || resolved.has(row.id))) await db.remove(row.id);
      }
      this.holds=this.holds.filter(row => !included.has(row.id) || (!row.engineSaved && !resolved.has(row.id)));
      this.rows=this.holds.filter(row=>row.operatorId===snapshot.user.id);
    });
    return project(snapshot,this.holds);
  }
  async admit(body) {
    const expected=this.session?.user.id;
    const {row,holds}=await storage.locked(async db => {
      const active=await db.get('active');
      if (!active?.snapshot || active.user.id!==expected || this.pair?.terminalId!==active.terminalId)
        throw new Error('Reconnect to authorize this terminal before taking cash.');
      const holds=await db.terminal(active.terminalId);
      const prior=await db.row(body.operationId);
      if (prior) {
        if(prior.operatorId!==expected || JSON.stringify(prior.input)!==JSON.stringify(body)) throw new Error('Receipt ID is already in use.');
        return {row:prior,holds};
      }
      const seqKey='sequence:'+active.terminalId, sequence=(await db.get(seqKey)||0)+1,now=Date.now();
      if(!Number.isSafeInteger(sequence)) throw new Error('Terminal sequence is unavailable.');
      const row=prepareSale(active,active.snapshot,holds,body,sequence,now);
      row.input=body;
      await db.put(seqKey,sequence); await db.save(row);
      await db.put('active',{...active,anchor:Math.max(active.anchor,now)});
      return {row,holds:[...holds,row]};
    });
    // An IndexedDB commit is the acknowledgment. Subsequent UI/storage reads cannot undo it.
    this.holds=holds;this.rows=holds.filter(r=>r.operatorId===expected);
    return row;
  }
  async flush() {
    if (!this.enabled || this.sending) return;
    const pair=this.pair, generation=this.generation;
    this.sending=true;
    try {
      let engine=null, cloud=true;
      const all=await storage.list(pair.operatorId);
      // Try newly recorded sales first, even when old receipts are awaiting a printer or review.
      const work=all.filter(r=>!(r.engineSaved&&r.cloudSaved)).sort((a,b) =>
        Number(!!a.engineSaved)-Number(!!b.engineSaved) || (a.checked||0)-(b.checked||0) || a.receipt.sequence-b.receipt.sequence);
      let attempts=0;
      for (const row of work) {
        if(attempts>=50)break;
        if (generation!==this.generation) break;
        if (row.receipt.terminalId!==pair.terminalId) continue;
        if (engine===null) engine=await identify(pair).then(()=>true,()=>false);
        let patch={};
        if (engine && (!row.engineSaved || Date.now()-(row.checked||0)>60000)) {
          attempts++;
          try {const status=await forward(pair,row); patch.engineSaved=true; patch.checked=Date.now();
            if(status!=='pending'){patch.cloudSaved=true;patch.review=status==='conflict';}}
          catch {engine=false;}
        }
        // The engine normally submits to the cloud. When unreachable, the browser uses the same operation/grant.
        if (!engine && cloud && !row.cloudSaved && navigator.onLine!==false) {
          try {
            attempts++;
            const ack=await request('/terminal/receipts',{grant:row.grant,receipt:row.receipt});
            if (ack.id===row.id && ['accepted','conflict'].includes(ack.status)) {
              patch.cloudSaved=true; patch.review=ack.status==='conflict'; patch.note=ack.error;
            }
          } catch {cloud=false;}
        }
        if (Object.keys(patch).length) await storage.locked(async db => {
          const latest=await db.row(row.id);
          if (latest) await db.save({...latest,...patch});
        });
        if (!engine && !cloud) break;
      }
      if(generation===this.generation) {
        const rows=await storage.list(pair.operatorId);
        const changed=JSON.stringify(rows.map(r=>[r.id,r.engineSaved,r.cloudSaved,r.review]))!==JSON.stringify(this.rows.map(r=>[r.id,r.engineSaved,r.cloudSaved,r.review]));
        this.rows=rows;
        if(changed) this.onChange?.();
      }
    } finally {this.sending=false;}
  }
  async clear() { await this.login(null); }
  async recoverCashierReceipts() {
    if (this.session?.user.role!=='owner') throw new Error('Only the Owner may reconcile another cashier’s receipts.');
    const rows=await storage.locked(db=>db.all());
    let count=0;
    for(const row of rows.filter(r=>!r.cloudSaved).slice(0,50)){
      const ack=await request('/terminal/receipts',{grant:row.grant,receipt:row.receipt});
      if(ack.id!==row.id || !['conflict','accepted'].includes(ack.status))throw new Error('Receipt acknowledgment could not be verified.');
      await storage.locked(async db=>{
        const stored=await db.row(row.id);
        if(stored)await db.save({...stored,cloudSaved:true,review:ack.status==='conflict',note:ack.error});
      });
      count++;
    }
    return count;
  }
}
globalThis.ClinchTerminal=Object.freeze({Terminal,prepareSale,project,validLease,transport:Object.freeze({keys,identify,forward})});
})();
