(() => {
'use strict';
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);
const localDemo = globalThis.location?.protocol === 'file:' || (loopback && new URLSearchParams(globalThis.location.search).get('demo') === '1');
const fbConfig = globalThis.CLINCH_FIREBASE_CONFIG;
const useFirebase = !localDemo && Boolean(fbConfig?.apiKey && fbConfig?.projectId);

let csrf = '';
function setSession(session) { csrf = session?.csrf || ''; }

const fail = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
};

/* ---------------- Direct Firebase Auth + Firestore Engine ---------------- */
const FB_VER = '11.0.2';
let fbPromise = null;
let fbState = {
  user: null,
  revision: 0,
  unsubs: [],
  listeners: new Set(),
  data: { resources: [], products: [], bookings: [], sales: [], employees: [], jobs: [], applications: [], audit: [], terminalReviews: [] },
  fromCache: false
};

async function loadFirebase() {
  if (!fbPromise) {
    fbPromise = (async () => {
      const [appMod, authMod, fsMod] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-firestore.js`)
      ]);
      const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(fbConfig);
      const auth = authMod.getAuth(app);
      const db = fsMod.initializeFirestore(app, {
        localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
      });
      return { appMod, authMod, fsMod, app, auth, db };
    })().catch(err => { fbPromise = null; throw err; });
  }
  return fbPromise;
}

function slotLockId(resourceId, date, hr) {
  return `${resourceId}_${date}_${String(hr).padStart(2, '0')}`;
}

function buildSnapshot() {
  const u = fbState.user;
  const d = fbState.data;
  const customer = u?.role === 'customer';
  const owner = u?.role === 'owner';
  return {
    user: u,
    revision: fbState.revision,
    serverTime: new Date().toISOString(),
    demo: false,
    fromCache: fbState.fromCache,
    resources: [...d.resources].sort((a, b) => b.type.localeCompare(a.type) || a.id.localeCompare(b.id)),
    bookings: d.bookings
      .filter(b => !customer || b.customerId === u.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour),
    products: [...d.products].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
    sales: customer ? [] : [...d.sales].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    employees: owner ? [...d.employees].sort((a, b) => a.name.localeCompare(b.name)) : [],
    jobs: [...d.jobs].sort((a, b) => a.title.localeCompare(b.title)),
    applications: customer
      ? d.applications.filter(a => a.customerId === u.id)
      : owner ? [...d.applications].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) : [],
    audit: owner ? [...d.audit].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 200) : [],
    terminalReviews: owner ? d.terminalReviews.filter(r => !r.resolved) : []
  };
}

function emitSnapshot() {
  if (!fbState.user) return;
  fbState.revision++;
  const snap = buildSnapshot();
  for (const fn of fbState.listeners) {
    try { fn(snap); } catch {}
  }
}

function stopRealtime() {
  for (const unsub of fbState.unsubs) { try { unsub(); } catch {} }
  fbState.unsubs = [];
  fbState.data = { resources: [], products: [], bookings: [], sales: [], employees: [], jobs: [], applications: [], audit: [], terminalReviews: [] };
}

async function startRealtime(user) {
  stopRealtime();
  fbState.user = user;
  if (!user) return;
  const { fsMod, db } = await loadFirebase();
  const { collection, query, where, orderBy, limit, onSnapshot } = fsMod;

  const watch = (key, q, mapDoc = d => ({ id: d.id, ...d.data() })) => {
    const unsub = onSnapshot(q, { includeMetadataChanges: true }, snap => {
      fbState.fromCache = snap.metadata.fromCache;
      fbState.data[key] = snap.docs.map(doc => {
        const row = mapDoc(doc);
        if (doc.metadata.hasPendingWrites) row.pendingSync = true;
        return row;
      });
      emitSnapshot();
    }, () => {
      fbState.fromCache = true;
      emitSnapshot();
    });
    fbState.unsubs.push(unsub);
  };

  watch('resources', collection(db, 'resources'));
  watch('products', collection(db, 'products'));
  watch('jobs', collection(db, 'jobs'));

  if (user.role === 'customer') {
    watch('bookings', query(collection(db, 'bookings'), where('customerId', '==', user.id)));
    watch('applications', query(collection(db, 'applications'), where('customerId', '==', user.id)));
  } else {
    watch('bookings', collection(db, 'bookings'));
    watch('sales', query(collection(db, 'sales'), orderBy('createdAt', 'desc'), limit(300)));
  }
  if (user.role === 'owner') {
    watch('employees', query(collection(db, 'users'), where('role', '==', 'employee')));
    watch('applications', collection(db, 'applications'));
    watch('audit', query(collection(db, 'audit'), orderBy('createdAt', 'desc'), limit(200)));
    watch('terminalReviews', query(collection(db, 'terminalReviews'), where('resolved', '==', false)));
  }
}

async function getCurrentFirebaseUser() {
  const { authMod, fsMod, auth, db } = await loadFirebase();
  const authUser = auth.currentUser || await new Promise(resolve => {
    const unsub = authMod.onAuthStateChanged(auth, u => { unsub(); resolve(u); });
  });
  if (!authUser) fail(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in.');
  const profileSnap = await fsMod.getDoc(fsMod.doc(db, 'users', authUser.uid));
  if (!profileSnap.exists()) fail(401, 'UNAUTHENTICATED', 'Account profile not found.');
  const profile = profileSnap.data();
  if (profile.active === false) {
    await authMod.signOut(auth);
    fail(401, 'DISABLED', 'This account has been deactivated.');
  }
  const user = { id: authUser.uid, name: profile.name, email: profile.email, role: profile.role };
  if (fbState.user?.id !== user.id) await startRealtime(user);
  return user;
}

async function firebaseApi(route, body) {
  const { appMod, authMod, fsMod, auth, db } = await loadFirebase();
  const { doc, collection, getDoc, getDocs, setDoc, updateDoc, runTransaction, query, where } = fsMod;
  const [path, queryStr = ''] = route.split('?');
  const nowIso = () => new Date().toISOString();

  if (path === '/login') {
    const cred = await authMod.signInWithEmailAndPassword(auth, String(body.email || '').trim().toLowerCase(), String(body.password || ''));
    const profileSnap = await getDoc(doc(db, 'users', cred.user.uid));
    if (!profileSnap.exists()) { await authMod.signOut(auth); fail(401, 'INVALID_CREDENTIALS', 'Account profile not found.'); }
    const profile = profileSnap.data();
    if (profile.active === false || profile.role !== body.role) {
      await authMod.signOut(auth);
      fail(401, 'INVALID_CREDENTIALS', 'Email, password, or selected role is incorrect.');
    }
    const user = { id: cred.user.uid, name: profile.name, email: profile.email, role: profile.role };
    await startRealtime(user);
    return { user, csrf: '', expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(), demo: false };
  }

  if (path === '/register') {
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const pass = String(body.password || '');
    if (pass.length < 12) fail(400, 'VALIDATION', 'Password must contain at least 12 characters.');
    const cred = await authMod.createUserWithEmailAndPassword(auth, email, pass);
    await setDoc(doc(db, 'users', cred.user.uid), { name, email, role: 'customer', active: true, createdAt: nowIso() });
    await authMod.signOut(auth);
    return { ok: true };
  }

  if (path === '/logout') {
    stopRealtime();
    fbState.user = null;
    await authMod.signOut(auth);
    return { ok: true };
  }

  const actor = await getCurrentFirebaseUser();

  if (path === '/session') {
    return { user: actor, csrf: '', expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(), demo: false };
  }

  if (path === '/snapshot') {
    if (!fbState.data.resources.length) {
      const [resSnap, prodSnap] = await Promise.all([getDocs(collection(db, 'resources')), getDocs(collection(db, 'products'))]);
      fbState.data.resources = resSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      fbState.data.products = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    return buildSnapshot();
  }

  if (path === '/availability') {
    const params = new URLSearchParams(queryStr);
    const date = params.get('date');
    const startHour = Number(params.get('startHour'));
    const endHour = Number(params.get('endHour'));
    if (!date || !Number.isInteger(startHour) || !Number.isInteger(endHour) || endHour <= startHour) {
      fail(400, 'VALIDATION', 'Choose a valid date and time range.');
    }
    const locksSnap = await getDocs(query(collection(db, 'slotLocks'), where('date', '==', date)));
    const locksByRes = new Map();
    locksSnap.forEach(d => {
      const l = d.data();
      if (l.hour >= startHour && l.hour < endHour) {
        const prev = locksByRes.get(l.resourceId);
        locksByRes.set(l.resourceId, prev === 'occupied' || l.status === 'occupied' ? 'occupied' : 'reserved');
      }
    });
    const resources = fbState.data.resources.length
      ? fbState.data.resources
      : (await getDocs(collection(db, 'resources'))).docs.map(d => ({ id: d.id, ...d.data() }));
    return {
      availability: [...resources].sort((a, b) => a.id.localeCompare(b.id)).map(r => ({
        resourceId: r.id,
        status: locksByRes.get(r.id) || 'available'
      }))
    };
  }

  if (path === '/bookings') {
    const opId = body.operationId || crypto.randomUUID();
    return runTransaction(db, async tx => {
      const opRef = doc(db, 'operations', opId);
      const opSnap = await tx.get(opRef);
      if (opSnap.exists()) return opSnap.data().result;

      const resSnap = await tx.get(doc(db, 'resources', body.resourceId));
      if (!resSnap.exists()) fail(404, 'NOT_FOUND', 'Choose an available resource.');
      const resource = resSnap.data();

      const starts = Date.parse(`${body.date}T${String(body.startHour).padStart(2, '0')}:00:00+08:00`);
      if (body.endHour <= body.startHour || starts < Date.now() || starts > Date.now() + 180 * 86400000) {
        fail(400, 'VALIDATION', 'Choose a future booking of at least one hour within 180 days.');
      }

      const lockRefs = [];
      for (let h = body.startHour; h < body.endHour; h++) {
        const ref = doc(db, 'slotLocks', slotLockId(body.resourceId, body.date, h));
        const lockSnap = await tx.get(ref);
        if (lockSnap.exists()) fail(409, 'BOOKING_CONFLICT', 'This space is already reserved during the selected time.');
        lockRefs.push({ ref, hour: h });
      }

      const id = crypto.randomUUID();
      const booking = {
        id,
        reference: `CL-${id.slice(0, 8).toUpperCase()}`,
        resourceId: body.resourceId,
        customerId: actor.role === 'customer' ? actor.id : null,
        customerName: actor.role === 'customer' ? actor.name : (String(body.customerName || '').trim() || 'Walk-in guest'),
        date: body.date,
        startHour: body.startHour,
        endHour: body.endHour,
        total: (body.endHour - body.startHour) * resource.rate,
        status: 'confirmed',
        paid: false,
        version: 1,
        source: 'web',
        createdAt: nowIso()
      };

      tx.set(doc(db, 'bookings', id), booking);
      for (const { ref, hour: h } of lockRefs) {
        tx.set(ref, { resourceId: body.resourceId, date: body.date, hour: h, status: 'reserved', bookingId: id });
      }
      tx.set(opRef, { type: 'booking', userId: actor.id, result: booking, createdAt: nowIso() });
      tx.set(doc(db, 'audit', crypto.randomUUID()), {
        userId: actor.id, actor: actor.name, action: 'booking.create', detail: booking.reference, createdAt: nowIso()
      });
      return booking;
    });
  }

  const bookingStatus = path.match(/^\/bookings\/([^/]+)\/status$/);
  if (bookingStatus) {
    const id = decodeURIComponent(bookingStatus[1]);
    return runTransaction(db, async tx => {
      const bRef = doc(db, 'bookings', id);
      const bSnap = await tx.get(bRef);
      if (!bSnap.exists()) fail(404, 'NOT_FOUND', 'Booking was not found.');
      const booking = bSnap.data();
      if (booking.version !== body.version) fail(409, 'STALE_VERSION', 'This booking changed. Refresh and review it.');
      const allowed = { confirmed: ['checked_in', 'cancelled'], checked_in: ['completed'], completed: [], cancelled: [] };
      if (!allowed[booking.status]?.includes(body.status)) fail(409, 'INVALID_TRANSITION', 'This booking status change is not allowed.');
      if (body.status === 'cancelled' && booking.paid) fail(409, 'PAID_BOOKING', 'Paid bookings cannot be cancelled.');
      if (body.status === 'completed' && !booking.paid) fail(409, 'UNPAID_BOOKING', 'Collect the booking payment before completing it.');

      const updated = { ...booking, status: body.status, version: booking.version + 1, updatedAt: nowIso() };
      tx.update(bRef, { status: updated.status, version: updated.version, updatedAt: updated.updatedAt });
      for (let h = booking.startHour; h < booking.endHour; h++) {
        const lRef = doc(db, 'slotLocks', slotLockId(booking.resourceId, booking.date, h));
        if (body.status === 'cancelled' || body.status === 'completed') tx.delete(lRef);
        else if (body.status === 'checked_in') tx.set(lRef, { resourceId: booking.resourceId, date: booking.date, hour: h, status: 'occupied', bookingId: id });
      }
      tx.set(doc(db, 'audit', crypto.randomUUID()), {
        userId: actor.id, actor: actor.name, action: 'booking.status', detail: `${booking.reference}: ${body.status}`, createdAt: nowIso()
      });
      return updated;
    });
  }

  if (path === '/sales') {
    if (!['owner', 'employee'].includes(actor.role)) fail(403, 'FORBIDDEN', 'Staff access required.');
    const opId = body.operationId || crypto.randomUUID();
    return runTransaction(db, async tx => {
      const opRef = doc(db, 'operations', opId);
      const opSnap = await tx.get(opRef);
      if (opSnap.exists()) return opSnap.data().result;

      const items = [];
      const prodUpdates = [];
      let total = 0;

      for (const line of body.items || []) {
        const pRef = doc(db, 'products', line.productId);
        const pSnap = await tx.get(pRef);
        if (!pSnap.exists()) fail(404, 'NOT_FOUND', 'Product was not found.');
        const p = pSnap.data();
        if (p.stock < line.quantity) fail(409, 'OUT_OF_STOCK', `${p.name} does not have enough stock.`);
        items.push({ productId: line.productId, productName: p.name, name: p.name, unitPrice: p.price, price: p.price, quantity: line.quantity, total: p.price * line.quantity });
        prodUpdates.push({ ref: pRef, nextStock: p.stock - line.quantity });
        total += p.price * line.quantity;
      }

      let bRef = null, booking = null;
      if (body.bookingId) {
        bRef = doc(db, 'bookings', body.bookingId);
        const bSnap = await tx.get(bRef);
        if (!bSnap.exists()) fail(404, 'NOT_FOUND', 'Booking was not found.');
        booking = bSnap.data();
        if (booking.version !== body.bookingVersion) fail(409, 'STALE_VERSION', 'This booking changed. Refresh before collecting payment.');
        if (booking.paid) fail(409, 'ALREADY_PAID', 'This booking has already been paid.');
        if (['cancelled', 'completed'].includes(booking.status)) fail(409, 'INVALID_BOOKING', 'This booking cannot be collected.');
        items.push({ bookingId: booking.id, productName: `Booking ${booking.reference}`, name: `Booking ${booking.reference}`, unitPrice: booking.total, price: booking.total, quantity: 1, total: booking.total });
        total += booking.total;
      }

      if (!items.length) fail(400, 'VALIDATION', 'Add a product or an unpaid booking.');
      if (!Number.isSafeInteger(body.tendered) || body.tendered < total) fail(409, 'INSUFFICIENT_CASH', 'Cash tendered is below the total.');

      for (const u of prodUpdates) tx.update(u.ref, { stock: u.nextStock });
      if (booking) tx.update(bRef, { paid: true, version: booking.version + 1 });

      const id = crypto.randomUUID();
      const sale = {
        id, operationId: opId, reference: `TX-${id.slice(0, 8).toUpperCase()}`,
        operatorId: actor.id, total, tendered: body.tendered, change: body.tendered - total,
        method: 'cash', source: 'web', syncStatus: 'synced', createdAt: nowIso(), items
      };
      tx.set(doc(db, 'sales', id), sale);
      tx.set(opRef, { type: 'sale', userId: actor.id, result: sale, createdAt: nowIso() });
      tx.set(doc(db, 'audit', crypto.randomUUID()), {
        userId: actor.id, actor: actor.name, action: 'sale.create', detail: `${sale.reference}: ${total} centavos`, createdAt: nowIso()
      });
      return sale;
    });
  }

  if (path === '/employees') {
    if (actor.role !== 'owner') fail(403, 'FORBIDDEN', 'Owner access required.');
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const pass = String(body.password || '');
    if (pass.length < 12) fail(400, 'VALIDATION', 'Password must contain at least 12 characters.');
    // Secondary Firebase App prevents signing the Owner out when creating an employee account.
    const secondary = appMod.initializeApp(fbConfig, `emp-${Date.now()}`);
    try {
      const secAuth = authMod.getAuth(secondary);
      const cred = await authMod.createUserWithEmailAndPassword(secAuth, email, pass);
      await setDoc(doc(db, 'users', cred.user.uid), { name, email, role: 'employee', active: true, createdAt: nowIso() });
      await authMod.signOut(secAuth);
      await setDoc(doc(db, 'audit', crypto.randomUUID()), {
        userId: actor.id, actor: actor.name, action: 'employee.create', detail: email, createdAt: nowIso()
      });
      return { ok: true };
    } finally {
      await appMod.deleteApp(secondary).catch(() => {});
    }
  }

  const empStatus = path.match(/^\/employees\/([^/]+)\/status$/);
  if (empStatus) {
    if (actor.role !== 'owner') fail(403, 'FORBIDDEN', 'Owner access required.');
    const id = decodeURIComponent(empStatus[1]);
    await updateDoc(doc(db, 'users', id), { active: Boolean(body.active) });
    await setDoc(doc(db, 'audit', crypto.randomUUID()), {
      userId: actor.id, actor: actor.name, action: 'employee.status', detail: `${id}: ${body.active ? 'active' : 'disabled'}`, createdAt: nowIso()
    });
    return { ok: true };
  }

  if (path === '/jobs') {
    if (actor.role !== 'owner') fail(403, 'FORBIDDEN', 'Owner access required.');
    const id = crypto.randomUUID();
    await setDoc(doc(db, 'jobs', id), {
      title: String(body.title || '').trim(),
      type: String(body.type || '').trim(),
      description: String(body.description || '').trim(),
      open: true,
      createdAt: nowIso()
    });
    await setDoc(doc(db, 'audit', crypto.randomUUID()), {
      userId: actor.id, actor: actor.name, action: 'job.create', detail: String(body.title || '').trim(), createdAt: nowIso()
    });
    return { ok: true };
  }

  if (path === '/applications') {
    if (actor.role !== 'customer') fail(403, 'FORBIDDEN', 'Customer access required.');
    const appId = `${body.jobId}_${actor.id}`;
    const appRef = doc(db, 'applications', appId);
    const existing = await getDoc(appRef);
    if (existing.exists()) fail(409, 'ALREADY_APPLIED', 'You have already applied for this opening.');
    await setDoc(appRef, {
      jobId: body.jobId, customerId: actor.id, customerName: actor.name,
      message: String(body.message || '').trim(), status: 'received', createdAt: nowIso()
    });
    return { ok: true };
  }

  const reviewMatch = path.match(/^\/terminal\/reviews\/([^/]+)$/);
  if (reviewMatch) {
    if (actor.role !== 'owner') fail(403, 'FORBIDDEN', 'Owner access required.');
    const id = decodeURIComponent(reviewMatch[1]);
    await updateDoc(doc(db, 'terminalReviews', id), {
      resolved: true, resolutionNote: String(body.note || '').trim(), resolvedBy: actor.id, resolvedAt: nowIso()
    });
    await setDoc(doc(db, 'audit', crypto.randomUUID()), {
      userId: actor.id, actor: actor.name, action: 'terminal.reconcile', detail: `${id}: ${String(body.note || '').trim()}`, createdAt: nowIso()
    });
    return { ok: true };
  }

  fail(404, 'NOT_FOUND', 'API route was not found.');
}

/* ---------------- Unified Entrypoint ---------------- */
async function api(path, body) {
  if (localDemo) return globalThis.ClinchDemo.request(path, body);
  if (useFirebase) return firebaseApi(path, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch {
        if (!response.ok) fail(response.status, 'HTTP_ERROR', `The hub returned an unexpected error (${response.status}).`);
        fail(502, 'INVALID_RESPONSE', 'The hub returned an unreadable response.');
      }
    }
    if (!response.ok) fail(response.status, data.code, data.error || 'Something went wrong. Please try again.');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The hub took too long to respond. Please check your connection.');
    if (e instanceof TypeError) throw new Error('The hub is unreachable. Check your connection and try again.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function subscribe(listener) {
  if (!useFirebase) return () => {};
  fbState.listeners.add(listener);
  return () => fbState.listeners.delete(listener);
}

globalThis.ClinchApi = Object.freeze({ api, setSession, subscribe, localDemo, realtime: useFirebase });
})();