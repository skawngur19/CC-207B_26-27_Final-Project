(async () => {
'use strict';
const {api,setSession,subscribe,localDemo,realtime}=globalThis.ClinchApi;
const {authView,shellView,bookingReview,bookingDetails,receiptView,field,reservationRows}=globalThis.ClinchViews;
const {icon}=globalThis.ClinchIcons;
const {phtDate,minStartHourForDate,escapeHTML:e,newOperationId,isCollectibleBooking,cartTotal}=globalThis.ClinchDomain;
const {CheckoutGuard}=globalThis.ClinchCheckout;

const initialToday=phtDate();
const initialNextDay=phtDate(new Date(Date.now()+86400000));
const state={
  localDemo,user:null,snapshot:null,page:'home',loginRole:'customer',authMode:'login',
  loading:false,offline:false,bookingFilter:'upcoming',staffDate:initialToday,lastKnownToday:initialToday,
  search:'',category:'All',cart:{},posBooking:'',tenderedInput:'',terminalStatusText:'',
  availability:[],availabilityError:'',availabilityLoading:false,
  reserve:{date:initialNextDay,startHour:13,endHour:16,resourceId:'',customerName:'',year:Number(initialNextDay.slice(0,4)),month:Number(initialNextDay.slice(5,7))-1}
};
state.checkout=new CheckoutGuard();

let terminal={enabled:false,rows:[],clear:async()=>{}}, terminalLoading, currentSession=null;
function hadPairing(){try{return !localDemo&&!realtime&&localStorage.getItem('clinch.terminal.paired')==='1';}catch{return false;}}
async function loadTerminal(){
  if(!terminalLoading)terminalLoading=Promise.all(['terminal-storage.js','terminal.js'].map(name=>new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.async=false;script.src='./'+name;script.onload=resolve;script.onerror=()=>reject(new Error('Terminal files could not load.'));document.head.append(script);
  }))).then(()=>{terminal=new globalThis.ClinchTerminal.Terminal(onTerminalChange);state.terminal=terminal;}).catch(err=>{terminalLoading=null;throw err;});
  return terminalLoading;
}
function terminalStatus() {
  const browser=terminal.rows.filter(r=>!r.engineSaved&&!r.cloudSaved).length;
  const reviewed=terminal.rows.filter(r=>r.review).length;
  const saved=terminal.rows.length-browser-reviewed;
  return [browser+' browser-only receipt'+(browser===1?'':'s'),saved>0?saved+' awaiting reconciliation':'',reviewed?reviewed+' for Owner review':''].filter(Boolean).join(' · ');
}
function onTerminalChange() {
  if (state.user?.id!==terminal.session?.user.id) return;
  state.terminalStatusText=terminalStatus();
  const label=document.querySelector('#terminal-status');
  if (label) label.textContent=state.terminalStatusText;
}
state.terminal=terminal;
function syncTerminal() { if(terminal.enabled) terminal.flush().catch(()=>{}); }

async function sessionStart(session) {
  if(hadPairing()){
    await loadTerminal();
    if(['owner','employee'].includes(session.user.role)) await terminal.login(session);
  }
  currentSession=session;setSession(session);state.user=session.user;
  state.terminalStatusText=terminal.enabled?terminalStatus():'';
  recoverCheckout(session.user);
}
async function lockOperator(message) {
  await terminal.clear().catch(()=>{});
  currentSession=null;
  state.user=null;state.snapshot=null;state.cart={};state.posBooking='';state.tenderedInput='';
  state.reserve.customerName='';state.offline=false;state.terminalStatusText='';
  pendingBooking=null;setSession(null);
  closeDialog();render();if(message)toast(message);
}

const app=document.querySelector('#app');const dialog=document.querySelector('#dialog');
let toastTimer;let availabilityRequest=0;let pendingBooking=null;let refreshing=false;

function checkMidnightRollover() {
  const nowDay=phtDate();
  if (nowDay!==state.lastKnownToday) {
    if (state.staffDate===state.lastKnownToday) state.staffDate=nowDay;
    if (state.reserve.date<nowDay) {
      const next=phtDate(new Date(Date.now()+86400000));
      state.reserve.date=next;
      state.reserve.year=Number(next.slice(0,4));
      state.reserve.month=Number(next.slice(5,7))-1;
    }
    state.lastKnownToday=nowDay;
  }
}

function render(){
  checkMidnightRollover();
  if (terminal.enabled) state.terminalStatusText=terminalStatus();
  const active=document.activeElement;let selector='';
  if(app.contains(active)){
    if(active.id)selector='#'+CSS.escape(active.id);
    else if(active.dataset.action)selector='[data-action="'+CSS.escape(active.dataset.action)+'"]'+(active.dataset.value?'[data-value="'+CSS.escape(active.dataset.value)+'"]':'')+(active.dataset.id?'[data-id="'+CSS.escape(active.dataset.id)+'"]':'');
  }
  app.innerHTML=state.user?shellView(state):authView(state);
  if(!state.user&&state.localDemo&&state.authMode==='login'){
    const email=app.querySelector('[name=email]');const password=app.querySelector('[name=password]');
    if(email)email.value='1234';if(password)password.value='1234';
  }
  if(selector)app.querySelector(selector)?.focus({preventScroll:true});
}
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),4800);}
function showDialog(content){dialog.innerHTML=`<button class="dialog-close icon-btn" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button>${content}`;if(!dialog.open)dialog.showModal();}
function showError(id,error){const el=document.getElementById(id);if(el)el.textContent=error.message||String(error);else toast(error.message||String(error));}
function closeDialog(){if(dialog.open)dialog.close();}
function buttonForReceipt(id){return `<button class="btn text" data-action="terminal-receipt" data-id="${e(id)}">Details</button>`;}
function terminalReceipt(row){
  const sale={reference:row.id,createdAt:row.receipt.occurredAt,items:row.lines,total:row.total,tendered:row.receipt.tendered,change:row.receipt.tendered-row.total};
  return receiptView(sale,row.review?'Owner review':row.cloudSaved?'Cloud recorded':row.engineSaved?'Windows recorded':'Pending sync');
}

function shouldSkipBackgroundRender() {
  if (dialog.open) return true;
  if (state.page==='reserve' && document.activeElement?.id==='walk-in-name') return true;
  if (state.page==='reservations' && document.activeElement?.id==='reservation-search') return true;
  if (state.page==='pos' && (state.checkout.locked || document.activeElement?.name==='tendered')) return true;
  return false;
}

// Live Firestore real-time subscription (instant updates without polling lag).
subscribe(snapshot => {
  if (!state.user || snapshot.user?.id !== state.user.id) return;
  const prevRev = state.snapshot?.revision;
  const prevOffline = state.offline;
  state.snapshot = snapshot;
  state.user = snapshot.user;
  state.offline = navigator.onLine === false;
  // Prune cart quantities if online stock dropped (website takes priority).
  if (!state.checkout.locked) {
    for (const [id, qty] of Object.entries(state.cart)) {
      const p = snapshot.products.find(x => x.id === id);
      if (!p || p.stock <= 0) delete state.cart[id];
      else if (qty > p.stock) state.cart[id] = p.stock;
    }
    if (state.posBooking && !isCollectibleBooking(snapshot.bookings.find(b => b.id === state.posBooking))) {
      state.posBooking = '';
    }
  }
  if ((prevRev !== snapshot.revision || prevOffline !== state.offline) && !shouldSkipBackgroundRender()) {
    render();
  } else if (state.page === 'reservations') {
    const tbody = document.querySelector('#reservations-tbody');
    if (tbody) tbody.innerHTML = reservationRows(state);
  }
});

async function refresh({quiet=false}={}){
  if(!state.user||refreshing)return false;
  refreshing=true;
  if(!quiet){state.loading=true;render();}
  let changed=false;
  try{
    const userId=state.user.id;
    if(!currentSession&&terminal.enabled){
      if(navigator.onLine===false){state.offline=true;return false;}
      const session=await api('/session');
      if(session.user.id!==userId){await lockOperator('The signed-in account changed. Please sign in again.');return false;}
      await terminal.login(session);currentSession=session;setSession(session);
    }
    const prevRev=state.snapshot?.revision;
    const prevOffline=state.offline;
    const snapshot=await api('/snapshot');
    if(state.user?.id!==userId)return false;
    if(snapshot.user.id!==userId){await lockOperator('The signed-in account changed. Please sign in again.');return false;}
    state.snapshot=snapshot;state.user=snapshot.user;state.offline=navigator.onLine===false && !localDemo;
    if(terminal.enabled){state.snapshot=await terminal.update(snapshot);syncTerminal();}
    changed=(prevRev!==state.snapshot.revision)||(prevOffline!==state.offline);
  }catch(error){
    if(error.status===401){await lockOperator('Your session ended. Please log in again.');}
    else{
      const wasOffline=state.offline;
      state.offline=true;
      changed=!wasOffline;
      if(!quiet)toast(error.message);
    }
  }finally{
    refreshing=false;state.loading=false;
    if(!quiet)render();
  }
  return changed;
}

async function navigate(page){
  closeDialog();state.page=page;
  if(page==='reserve'){
    const minStart=minStartHourForDate(state.reserve.date);
    if(minStart>21){
      const next=phtDate(new Date(Date.now()+86400000));
      state.reserve.date=next;state.reserve.startHour=13;state.reserve.endHour=16;
      state.reserve.year=Number(next.slice(0,4));state.reserve.month=Number(next.slice(5,7))-1;
    }else if(state.reserve.startHour<minStart){
      state.reserve.startHour=minStart;
      if(state.reserve.endHour<=state.reserve.startHour)state.reserve.endHour=Math.min(22,state.reserve.startHour+1);
    }
    render();await loadAvailability();
  }else{
    await refresh({quiet:true});render();
  }
  document.querySelector('#main')?.scrollIntoView({behavior:'instant',block:'start'});
}
async function loadAvailability(){
  if(!state.user)return;
  const r=state.reserve;
  if(minStartHourForDate(r.date)>21){state.availability=[];state.availabilityError='';state.reserve.resourceId='';render();return;}
  const request=++availabilityRequest;state.availabilityLoading=true;state.availabilityError='';render();
  try{
    const data=await api(`/availability?date=${r.date}&startHour=${r.startHour}&endHour=${r.endHour}`);
    if(request!==availabilityRequest)return;
    state.availability=data.availability;
    if(!realtime)state.offline=false;
    if(state.availability.some(a=>a.resourceId===r.resourceId&&a.status!=='available'))r.resourceId='';
  }catch(error){
    if(request!==availabilityRequest)return;
    state.availabilityError=error.message;state.reserve.resourceId='';
  }finally{
    if(request===availabilityRequest){state.availabilityLoading=false;render();}
  }
}
function formValues(form){return Object.fromEntries(new FormData(form));}
function recoverCheckout(user){
  state.checkout=new CheckoutGuard();state.cart={};state.posBooking='';state.tenderedInput='';
  if(user.role==='customer')return;
  try{
    const saved=JSON.parse(sessionStorage.getItem(`clinch-checkout:${user.id}`));
    if(saved?.body?.operationId&&Array.isArray(saved.body.items)){
      if(!Number.isSafeInteger(saved.body.tendered)||saved.body.tendered<0||!Number.isSafeInteger(saved.total)||saved.total<0||!saved.body.items.every(x=>x&&typeof x.productId==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(x.productId)&&Number.isSafeInteger(x.quantity)&&x.quantity>0&&x.quantity<=100))throw new Error('Invalid saved payment');
      state.checkout.restore(saved.body,saved.total);
      state.cart=Object.fromEntries(saved.body.items.map(x=>[x.productId,x.quantity]));
      state.posBooking=typeof saved.body.bookingId==='string'?saved.body.bookingId:'';
      toast('An unconfirmed checkout was recovered. Open Point of sale and retry it safely.');
    }
  }catch{toast('The saved checkout could not be read. Review transaction history before taking another payment.');}
}
function saveCheckout(){
  if(!state.user)return;
  const key=`clinch-checkout:${state.user.id}`;
  if(state.checkout.body)sessionStorage.setItem(key,JSON.stringify({body:state.checkout.body,cart:state.cart,bookingId:state.posBooking,total:state.checkout.quotedTotal}));
  else sessionStorage.removeItem(key);
}
async function submitting(form,fn,errorId){
  const submit=form.querySelector('[type="submit"]');
  if(submit?.disabled)return;
  if(submit)submit.disabled=true;
  const error=document.getElementById(errorId);
  if(error)error.textContent='';
  try{await fn();}catch(err){showError(errorId,err);}
  finally{if(submit?.isConnected)submit.disabled=false;}
}

document.addEventListener('submit',async event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();
  const data=formValues(form);
  if(form.id==='login-form')await submitting(form,async()=>{
    const session=await api('/login',{...data,role:state.loginRole});
    await sessionStart(session);
    state.page=state.checkout.uncertain?'pos':session.user.role==='customer'?'home':'dashboard';
    state.authMode='login';await refresh();
  },'auth-error');
  if(form.id==='register-form')await submitting(form,async()=>{
    await api('/register',{name:data.name,email:data.email,password:data.password});
    state.authMode='login';state.loginRole='customer';render();
    toast('Your account is ready. Log in to make room for focus.');
  },'auth-error');
  if(form.id==='checkout-form'&&!state.checkout.busy)await submitting(form,async()=>{
    const tendered=Math.round(Number(data.tendered)*100);
    if(!Number.isSafeInteger(tendered)||tendered<0)throw new Error('Enter a valid cash amount.');
    const rawBooking=state.snapshot.bookings.find(b=>b.id===state.posBooking);
    const booking=isCollectibleBooking(rawBooking)?rawBooking:null;
    if(state.posBooking&&!booking&&!state.checkout.uncertain){
      state.posBooking='';render();
      throw new Error('That reservation is no longer unpaid or active. Review the order total.');
    }
    const validItems=[];
    for(const [productId,quantity] of Object.entries(state.cart)){
      if(quantity<=0)continue;
      const product=state.snapshot.products.find(p=>p.id===productId);
      if(!product||product.stock<quantity){
        if(!state.checkout.uncertain){
          if(!product||product.stock<=0)delete state.cart[productId]; else state.cart[productId]=product.stock;
          render();
          throw new Error(`${product?product.name:'An item in the cart'} is out of stock. Review the order.`);
        }
      }else{
        validItems.push({productId,quantity,unitPrice:product.price});
      }
    }
    const total=cartTotal(state.snapshot.products,state.cart,booking);
    if(!validItems.length&&!booking&&!state.checkout.uncertain)throw new Error('Add a product or an unpaid booking.');
    if(tendered<total&&!state.checkout.uncertain)throw new Error('Cash received must cover the total.');
    const payload={
      items:validItems.map(({productId,quantity})=>({productId,quantity})),
      method:'cash',tendered,
      ...(booking?{bookingId:booking.id,bookingVersion:booking.version}:{})
    };
    if(terminal.enabled&&!state.checkout.uncertain){
      if(booking)payload.bookingTotal=booking.total;
      payload.items=validItems;
      const body=state.checkout.begin(payload,total);
      let row;
      try{row=await terminal.admit(body);}catch(error){state.checkout.failed(400,'VALIDATION');throw new Error(error.message+' Checkout was not confirmed.');}
      state.checkout.accepted();state.cart={};state.posBooking='';state.tenderedInput='';
      state.snapshot=globalThis.ClinchTerminal.project(terminal.lastSnapshot||terminal.active.snapshot,terminal.holds);
      render();showDialog(terminalReceipt(row));syncTerminal();return;
    }
    const body=state.checkout.begin(payload,total);
    try{saveCheckout();}catch{state.checkout.failed(400,'VALIDATION');throw new Error('Your browser could not preserve this payment for safe retry. No payment was sent.');}
    render();
    try{
      const sale=await api('/sales',body);
      state.checkout.accepted();saveCheckout();state.cart={};state.posBooking='';state.tenderedInput='';
      await refresh();showDialog(receiptView(sale));toast('Checkout complete. Your receipt is recorded.');
    }catch(error){
      state.checkout.failed(error.status,error.code);saveCheckout();
      if(state.checkout.uncertain)error.message='Confirmation is uncertain. Keep this order and retry: the same operation ID prevents duplicate payment.';
      if(error.status===401){await lockOperator('Your session expired. Log in with the same account to safely resolve the saved checkout.');return;}
      render();throw error;
    }
  },'checkout-error');
  if(form.id==='terminal-pair-form')await submitting(form,async()=>{
    await loadTerminal();await terminal.login(currentSession);
    localStorage.setItem('clinch.terminal.paired','1');
    await terminal.pairWith(data.secret);closeDialog();await refresh();toast('Paired with this Windows terminal.');
  },'dialog-error');
  if(form.id==='terminal-review-form')await submitting(form,async()=>{
    await api('/terminal/reviews/'+encodeURIComponent(data.id),{note:data.note});closeDialog();await refresh();toast('Reconciliation note saved.');
  },'dialog-error');
  if(form.id==='employee-form')await submitting(form,async()=>{await api('/employees',data);closeDialog();await refresh();toast('Employee account created.');},'dialog-error');
  if(form.id==='job-form')await submitting(form,async()=>{await api('/jobs',data);closeDialog();await refresh();toast('Your Clinch opening is posted.');},'dialog-error');
  if(form.id==='application-form')await submitting(form,async()=>{await api('/applications',data);closeDialog();await refresh();toast('Application sent to the Clinch team.');},'dialog-error');
});

document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
  const {action,value,id}=target.dataset;if(target.tagName==='A')event.preventDefault();
  try{
    if(action==='role'){state.loginRole=value;render();}
    else if(action==='register'||action==='login'){state.authMode=action;render();}
    else if(action==='nav')await navigate(value);
    else if(action==='go-home')await navigate(state.user?.role==='customer'?'home':'dashboard');
    else if(['reserve','bookings','jobs','pos','reservations'].includes(action))await navigate(action);
    else if(action==='refresh'){await refresh();if(state.page==='reserve')await loadAvailability();}
    else if(action==='availability')await loadAvailability();
    else if(action==='show-password'){const password=document.querySelector('input[name="password"]');if(password)password.type=target.checked?'text':'password';}
    else if(action==='help-login')showDialog(`<div class="dialog-emblem">${icon('lock')}</div><h2 id="dialog-title">A little help getting back.</h2><p class="muted">${state.localDemo?'For this local test, select your account type and enter <strong>1234</strong> in both fields. No server is needed in local demo mode.':'For account recovery or password resets, visit the Clinch front desk.'}</p><button class="btn primary wide" data-action="close-dialog">Got it</button>`);
    else if(action==='privacy')showDialog(`<h2 id="dialog-title">Your space. Your privacy.</h2><p>${state.localDemo?'This local demo stores sample account details, reservations, applications and cash receipts in this browser.':'Account details, reservations, applications, and cash receipts are synced securely with Clinch Study Hub.'}</p><p>Customer booking details are visible to that customer and authorized staff. Job applications are reviewed by the Owner. No payment card details are collected.</p><button class="btn primary wide" data-action="close-dialog">Close</button>`);
    else if(action==='close-dialog')closeDialog();
    else if(action==='notifications')showDialog(`<div class="dialog-emblem">${icon('bell')}</div><h2 id="dialog-title">You’re all caught up.</h2><p class="muted">Your confirmed bookings are saved under My bookings. We’ll keep the important details there.</p><button class="btn primary wide" data-action="close-dialog">All right</button>`);
    else if(action==='month-prev'||action==='month-next'){const r=state.reserve;const date=new Date(Date.UTC(r.year,r.month+(action==='month-next'?1:-1),1));r.year=date.getUTCFullYear();r.month=date.getUTCMonth();render();}
    else if(action==='date'){
      state.reserve.date=value;
      const minStart=minStartHourForDate(value);
      if(minStart<=21&&state.reserve.startHour<minStart){
        state.reserve.startHour=minStart;
        if(state.reserve.endHour<=state.reserve.startHour)state.reserve.endHour=Math.min(22,state.reserve.startHour+1);
      }
      pendingBooking=null;await loadAvailability();
    }
    else if(action==='seat'){state.reserve.resourceId=value;pendingBooking=null;render();}
    else if(action==='booking-filter'){state.bookingFilter=value;render();}
    else if(action==='review-booking'){
      if(!state.reserve.resourceId)return;
      const customerName=(document.querySelector('#walk-in-name')?.value||state.reserve.customerName||'').trim();
      state.reserve.customerName=customerName;
      if(state.user.role!=='customer'&&!customerName){toast('Enter the walk-in customer’s name.');document.querySelector('#walk-in-name')?.focus();return;}
      const {date,startHour,endHour,resourceId}=state.reserve;
      const payload={date,startHour,endHour,resourceId,...(customerName?{customerName}:{})};
      const fingerprint=JSON.stringify(payload);
      if(!pendingBooking||pendingBooking.fingerprint!==fingerprint)pendingBooking={fingerprint,body:{...payload,operationId:newOperationId()}};
      showDialog(bookingReview(state));
    }
    else if(action==='confirm-booking'){
      if(!pendingBooking)return;
      target.disabled=true;
      try{
        const booking=await api('/bookings',pendingBooking.body);
        pendingBooking=null;state.reserve.customerName='';state.reserve.resourceId='';
        await refresh({quiet:true});state.page=state.user.role==='customer'?'bookings':'reservations';render();
        showDialog(bookingDetails(booking,state,true));toast(`Reservation confirmed. ${booking.resourceId} is saved.`);
      }catch(error){
        showError('dialog-error',error);
        if(error.status===409){state.availabilityError='That space was just reserved. Keep editing to choose another.';}
      }finally{if(target.isConnected)target.disabled=false;}
    }
    else if(action==='after-booking'){await navigate(state.user.role==='customer'?'bookings':'reservations');}
    else if(action==='booking-detail'){const booking=state.snapshot?.bookings.find(b=>String(b.id)===id);if(booking)showDialog(bookingDetails(booking,state));else toast('Booking could not be found.');}
    else if(action==='cancel-booking'){showDialog(`<h2 id="dialog-title">Cancel this reservation?</h2><p class="muted">This will release your space for someone else.</p><p id="dialog-error" class="form-error" role="alert"></p><button class="btn primary wide" data-action="booking-status" data-id="${e(id)}" data-value="cancelled">Yes, cancel reservation</button><button class="btn secondary wide" data-action="booking-detail" data-id="${e(id)}">Keep my spot</button>`);}
    else if(action==='booking-status'){
      const booking=state.snapshot?.bookings.find(b=>String(b.id)===id);
      if(!booking){closeDialog();toast('This booking was updated. Please refresh.');return;}
      target.disabled=true;
      try{await api(`/bookings/${encodeURIComponent(id)}/status`,{status:value,version:booking.version});closeDialog();await refresh();toast('Reservation updated.');}
      catch(error){showError('dialog-error',error);}
      finally{if(target.isConnected)target.disabled=false;}
    }
    else if(action==='collect-payment'){if(state.checkout.locked)toast('Resolve the current checkout before collecting another booking.');else state.posBooking=id;await navigate('pos');}
    else if(action==='category'){state.category=value;render();}
    else if(action==='add-cart'){
      if(state.checkout.locked)return;
      const p=state.snapshot?.products.find(x=>x.id===id);
      if(!p||p.stock<=0){toast('That item is currently sold out.');return;}
      const qty=state.cart[id]||0;
      if(qty>=p.stock){toast('That’s all the available stock for this item.');return;}
      state.cart[id]=qty+1;render();
    }
    else if(action==='cart-minus'){if(state.checkout.locked)return;const next=Math.max(0,(state.cart[id]||0)-1);if(next===0)delete state.cart[id];else state.cart[id]=next;render();}
    else if(action==='clear-cart'){if(state.checkout.locked)return;state.cart={};state.posBooking='';state.tenderedInput='';render();}
    else if(action==='receipt'){const sale=state.snapshot?.sales.find(x=>String(x.id)===id);if(sale)showDialog(receiptView(sale));}
    else if(action==='terminal-pair')showDialog(`<h2 id="dialog-title">Pair this cash desk</h2><p>Open the Windows engine and copy the pairing key for your staff account. Allow this site to connect to the local terminal when prompted.</p><form id="terminal-pair-form" class="form-stack">${field('Windows pairing key','secret','password','Paste pairing key','required autocomplete="off" maxlength="256"')}<p id="dialog-error" class="form-error" role="alert"></p><button class="btn primary wide" type="submit">Connect terminal</button></form>`);
    else if(action==='terminal-recover'){
      if(state.user.role!=='owner'||!hadPairing())return;
      if(!currentSession){currentSession=await api('/session');setSession(currentSession);}
      await loadTerminal();await terminal.login(currentSession);
      const {count,remaining}=await terminal.recoverCashierReceipts();await refresh();
      toast(count?`Submitted ${count} cashier receipt(s)${remaining?` (${remaining} more remaining — run again).`:' for reconciliation.'}`:'All local cashier receipts have reached the cloud.');
    }
    else if(action==='terminal-queue'){
      showDialog(`<h2 id="dialog-title">Terminal receipts</h2><p class="muted">${e(terminalStatus())}</p>${terminal.rows.map(r=>`<div class="detail-line"><span>${e(r.id.slice(0,12))}<small> · ${globalThis.ClinchDomain.money(r.total)}</small></span>${buttonForReceipt(r.id)}</div>`).join('')}<button class="btn secondary wide" data-action="terminal-retry">Sync receipts</button>`);
    }
    else if(action==='terminal-retry'){await terminal.flush();await refresh({quiet:true});render();closeDialog();toast(terminalStatus());}
    else if(action==='terminal-receipt'){const row=terminal.rows.find(r=>r.id===id);if(row)showDialog(terminalReceipt(row));}
    else if(action==='terminal-review'){const review=state.snapshot?.terminalReviews?.find(r=>r.id===id);if(review)showDialog(`<h2 id="dialog-title">Reconcile cash receipt</h2><p>${e(review.error)}</p><p class="small">${e(review.receipt?.operationId||review.id)} · ${e(review.receipt?.operatorId||'Owner')} · Cash tendered ${globalThis.ClinchDomain.money(review.receipt?.tendered||0)}</p><form id="terminal-review-form" class="form-stack"><input type="hidden" name="id" value="${e(id)}"><label class="field"><span>How was the cash reconciled?</span><textarea required minlength="3" maxlength="500" name="note"></textarea></label><p id="dialog-error" class="form-error" role="alert"></p><button class="btn primary wide" type="submit">Record resolution</button></form>`);}
    else if(action==='add-employee')showDialog(`<div class="dialog-emblem">${icon('users')}</div><h2 id="dialog-title">Make room for a teammate.</h2><p class="muted">Only you can create an employee account.</p><form id="employee-form" class="form-stack">${field('Full name','name','text','Employee’s name','required maxlength="100"')}${field('Email address','email','email','name@example.com','required maxlength="254" autocomplete="off"')}${field('Temporary password','password','password','At least 12 characters','required minlength="12" maxlength="128" autocomplete="new-password"')}<p id="dialog-error" class="form-error" role="alert"></p><button class="btn primary wide" type="submit">Create employee account</button></form>`);
    else if(action==='employee-status')showDialog(`<h2 id="dialog-title">${value==='true'?'Activate':'Deactivate'} employee?</h2><p class="muted">${value==='true'?'This restores their access to the hub workspace.':'Their sign-in access will stop. Existing records and transactions stay in the hub.'}</p><p id="dialog-error" class="form-error" role="alert"></p><button class="btn primary wide" data-action="confirm-employee-status" data-id="${e(id)}" data-value="${value}">Confirm</button><button class="btn secondary wide" data-action="close-dialog">Keep editing</button>`);
    else if(action==='confirm-employee-status'){target.disabled=true;try{await api(`/employees/${encodeURIComponent(id)}/status`,{active:value==='true'});closeDialog();await refresh();toast('Employee access updated.');}catch(error){showError('dialog-error',error);if(target.isConnected)target.disabled=false;}}
    else if(action==='add-job')showDialog(`<h2 id="dialog-title">A new opportunity at Clinch.</h2><form id="job-form" class="form-stack">${field('Job title','title','text','e.g. Study Hub Associate','required maxlength="100"')}${field('Work arrangement','type','text','e.g. Part-time','required maxlength="50"')}<label class="field"><span>About the role</span><textarea name="description" rows="5" required maxlength="2000" placeholder="Tell future teammates about the role…"></textarea></label><p id="dialog-error" class="form-error" role="alert"></p><button type="submit" class="btn primary wide">Post opening</button></form>`);
    else if(action==='apply-job'){const job=state.snapshot?.jobs.find(j=>j.id===id);if(!job){toast('That opening is no longer available.');return;}showDialog(`<div class="dialog-emblem">${icon('briefcase')}</div><h2 id="dialog-title">${e(job.title)}</h2><p class="muted">Introduce yourself to the Clinch team. Your account name and email will accompany your application.</p><form id="application-form" class="form-stack"><input type="hidden" name="jobId" value="${e(id)}"><label class="field"><span>Why would you like to work at Clinch?</span><textarea name="message" rows="6" required minlength="20" maxlength="2000" placeholder="A little about you, your availability, and your experience…"></textarea></label><p id="dialog-error" class="form-error" role="alert"></p><button class="btn primary wide" type="submit">Send application</button></form>`);}
    else if(action==='logout'){
      if(state.checkout.locked){toast('Resolve the pending checkout before logging out.');return;}
      if(terminal.rows.some(r=>!r.engineSaved&&!r.cloudSaved)){toast('Sync browser-only receipts before signing out.');return;}
      await api('/logout',{}).catch(()=>{});
      await lockOperator('See you next time.');
    }
  }catch(error){toast(error.message);}
});

document.addEventListener('change',async event=>{
  const el=event.target;
  if(el.id==='start-hour'){state.reserve.startHour=Number(el.value);if(state.reserve.endHour<=state.reserve.startHour)state.reserve.endHour=state.reserve.startHour+1;pendingBooking=null;await loadAvailability();}
  if(el.id==='end-hour'){state.reserve.endHour=Number(el.value);pendingBooking=null;await loadAvailability();}
  if(el.id==='pos-booking'){if(!state.checkout.locked)state.posBooking=el.value;render();}
  if(el.id==='staff-date'){state.staffDate=el.value;render();}
});

document.addEventListener('input',event=>{
  const el=event.target;
  if(el.id==='reservation-search'){
    state.search=el.value;
    const tbody=document.querySelector('#reservations-tbody');
    if(tbody)tbody.innerHTML=reservationRows(state);
  }else if(el.id==='walk-in-name'){
    state.reserve.customerName=el.value;
  }else if(el.name==='tendered'&&el.closest('#checkout-form')&&!state.checkout.locked){
    state.tenderedInput=el.value;
  }
});

dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
window.addEventListener('online',()=>{if(state.user){state.offline=false;refresh();}});
window.addEventListener('offline',()=>{if(state.user&&!state.localDemo){state.offline=true;render();}});

// Only poll on non-realtime transports; skip redundant renders when revision is unchanged.
setInterval(async()=>{
  if(realtime||!state.user||document.hidden||shouldSkipBackgroundRender()||state.page==='reserve')return;
  if(state.page==='pos'&&(!terminal.enabled||state.checkout.locked||state.posBooking||Object.values(state.cart).some(q=>q>0)))return;
  const changed=await refresh({quiet:true});
  if(changed)render();
},30000);

setInterval(()=>{
  if(!terminal.enabled||!state.user)return;
  if(terminal.active&&!globalThis.ClinchTerminal.validLease(terminal.active)){
    lockOperator('Your terminal session ended. Reconnect and sign in.');return;
  }
  if(!document.hidden)syncTerminal();
},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncTerminal();});

if(!localDemo&&globalThis.isSecureContext&&'serviceWorker' in navigator){
  const register=()=>navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>{
    reg.addEventListener('updatefound',()=>{const next=reg.installing;next?.addEventListener('statechange',()=>{
      if(next.state==='installed'&&navigator.serviceWorker.controller)toast('Update ready. Finish checkout, then reload Clinch to update.');
    });});
  }).catch(()=>toast('Offline reopening is unavailable until this site finishes saving its files.'));
  if(document.readyState==='complete')register();else window.addEventListener('load',register,{once:true});
}

if(hadPairing()){
  await loadTerminal().catch(()=>{});
  const saved=await terminal.restore?.().catch(()=>null);
  if(saved){state.user=saved.user;state.snapshot=saved.snapshot;state.offline=true;state.page='pos';recoverCheckout(saved.user);render();syncTerminal();}
}
try{
  if(!localDemo&&!realtime&&navigator.onLine===false)throw new Error('Offline');
  const session=await api('/session');
  if(state.user&&state.user.id===session.user.id&&terminal.enabled){
    currentSession=session;setSession(session);terminal.session=session;
    if(terminal.active?.until!==Date.parse(session.expiresAt))await terminal.authorize();
    await refresh({quiet:true});render();
  }else{
    await sessionStart(session);
    state.page=state.checkout.uncertain?'pos':session.user.role==='customer'?'home':'dashboard';await refresh();
  }
}catch(error){
  if(error.status===401||error.status===403)await lockOperator();
  render();
}
})();