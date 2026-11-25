/* Browser-only demonstration data. This is not authentication for real customer use. */
(() => {
  'use strict';
  const STORE_KEY = 'clinch.local-demo.v1';
  const SESSION_MS = 8 * 60 * 60 * 1000;
  const ROLES = ['customer', 'employee', 'owner'];
  const copy = value => JSON.parse(JSON.stringify(value));
  const stamp = () => new Date().toISOString();
  const phtDate = value => new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fail = (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
  };
  const object = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'VALIDATION', 'A JSON object is required.');
    return value;
  };
  const text = (value, label, max = 160, min = 1) => {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      fail(400, 'VALIDATION', `${label} must contain ${min}–${max} characters.`);
    }
    return value.trim();
  };
  const int = (value, label, min, max) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, 'VALIDATION', `${label} is outside its allowed range.`);
    return value;
  };
  const email = value => {
    const address = text(value, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) fail(400, 'VALIDATION', 'Enter a valid email address.');
    return address;
  };
  const password = value => {
    if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail(400, 'VALIDATION', 'Password must contain 12–128 characters.');
    return value;
  };
  const opId = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail(400, 'VALIDATION', 'A valid unique operation ID is required.');
    return value;
  };
  const requireRole = (user, ...roles) => {
    if (!user || !roles.includes(user.role)) fail(403, 'FORBIDDEN', 'This action is not available to this role.');
  };
  const publicUser = user => ({id: user.id, name: user.name, email: user.email, role: user.role});
  const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const uniqueId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (globalThis.crypto?.getRandomValues) return hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    fail(503, 'LOCAL_CRYPTO_UNAVAILABLE', 'This browser needs Web Crypto to use the local demo.');
  };
  async function derivePassword(value, salt, iterations) {
    if (!globalThis.crypto?.subtle) fail(503, 'LOCAL_CRYPTO_UNAVAILABLE', 'This browser needs Web Crypto to create local demo accounts.');
    const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
    const result = await globalThis.crypto.subtle.deriveBits({name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256'}, key, 256);
    return hex(new Uint8Array(result));
  }
  async function hashPassword(value) {
    const salt = uniqueId(), iterations = 120000;
    return `pbkdf2-sha256$${iterations}$${salt}$${await derivePassword(value, salt, iterations)}`;
  }
  async function verifyPassword(value, user) {
    // The three seeded accounts are deliberately public demo identities only.
    if (user.demoCredential === true) return value === '1234';
    if (typeof user.passwordHash !== 'string') return false;
    const [algorithm, rounds, salt, expected] = user.passwordHash.split('$');
    const iterations = Number(rounds);
    if (algorithm !== 'pbkdf2-sha256' || !Number.isSafeInteger(iterations) || iterations < 120000 || iterations > 1000000 || !salt || !/^[a-f0-9]{64}$/.test(expected ?? '')) return false;
    const actual = await derivePassword(value, salt, iterations);
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
    return difference === 0;
  }
  function seed() {
    const createdAt = stamp(), date = phtDate(Date.now());
    const resources = Array.from({length: 12}, (_, index) => {
      const id = `A${String(index + 1).padStart(2, '0')}`;
      return {id, name: `Seat ${id}`, type: 'seat', capacity: 1, rate: 5000};
    });
    for (const [id, name, capacity, rate] of [['narra', 'Narra', 4, 20000], ['acacia', 'Acacia', 6, 30000], ['molave', 'Molave', 4, 20000]]) {
      resources.push({id, name: `${name} Room`, type: 'room', capacity, rate});
    }
    const users = [['owner', 'Alex Rivera', 'owner@clinch.local'], ['employee', 'Jamie Santos', 'employee@clinch.local'], ['customer', 'Alex Cruz', 'alex@clinch.local']]
      .map(([role, name, address]) => ({id: role, name, email: address, role, active: true, demoCredential: true, createdAt}));
    const products = [['coffee', 'Brewed Coffee', 'Drinks', 3000, 40], ['latte', 'Cafe Latte', 'Drinks', 7500, 25], ['tea', 'Iced Tea', 'Drinks', 4500, 30], ['water', 'Bottled Water', 'Drinks', 2500, 50], ['cookie', 'Chocolate Cookie', 'Snacks', 4000, 24], ['notebook', 'Clinch Notebook', 'Essentials', 8500, 15]]
      .map(([id, name, category, price, stock]) => ({id, name, category, price, stock}));
    const bookings = [['demo-1', 'DEMO-1001', 'A03', 'Alex Cruz', 13, 15, 'confirmed', false], ['demo-2', 'DEMO-1002', 'narra', 'Study group', 10, 12, 'checked_in', false], ['demo-3', 'DEMO-1003', 'A07', 'Morning guest', 8, 10, 'completed', true]]
      .map(([id, reference, resourceId, customerName, startHour, endHour, status, paid]) => ({id, reference, resourceId,
        customerId: id === 'demo-1' ? 'customer' : null, customerName, date, startHour, endHour,
        total: resources.find(resource => resource.id === resourceId).rate * (endHour - startHour), status, paid, version: 1}));
    return {schema: 1, revision: 1, users, resources, products, bookings, session: null, receipts: [], sales: [], applications: [],
      jobs: [{id: 'community-associate', title: 'Community Associate', type: 'Part-time', description: 'Welcome members, prepare refreshments, and help keep our study spaces calm and organized.', open: true},
        {id: 'hub-associate', title: 'Hub Operations Associate', type: 'Full-time', description: 'Support bookings, daily operations, and a welcoming experience at Clinch Study Hub.', open: true}],
      audit: [{id: uniqueId(), userId: 'owner', actor: 'Alex Rivera', action: 'demo.seed', detail: 'Browser-local demo initialized; no real payments or server synchronization.', createdAt}]};
  }
  let memory = null, storageAvailable = true, queue = Promise.resolve();
  function readState() {
    if (storageAvailable) {
      try {
        const raw = globalThis.localStorage?.getItem(STORE_KEY);
        if (raw) {
          const value = JSON.parse(raw);
          if (value?.schema === 1 && Number.isSafeInteger(value.revision)
            && ['users', 'resources', 'products', 'bookings', 'receipts', 'sales', 'jobs', 'applications', 'audit'].every(name => Array.isArray(value[name]))) memory = value;
          else storageAvailable = false;
        }
      } catch { storageAvailable = false; }
    }
    return copy(memory || (memory = seed()));
  }
  function saveState(state) {
    memory = state;
    if (storageAvailable) {
      try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(state)); }
      catch { storageAvailable = false; }
    }
  }
  const audit = (state, actor, action, detail) => state.audit.push({id: uniqueId(), userId: actor.id, actor: actor.name, action, detail, createdAt: stamp()});
  function session(state) {
    const saved = state.session;
    const user = saved && state.users.find(item => item.id === saved.userId);
    if (!saved || !user?.active || saved.expires <= Date.now()) fail(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in.');
    return {user: publicUser(user), csrf: saved.csrf, expiresAt: new Date(saved.expires).toISOString(), demo: true, localDemo: true};
  }
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  }
  const startsAt = booking => Date.parse(`${booking.date}T${String(booking.startHour).padStart(2, '0')}:00:00+08:00`);
  const overlapping = (state, resourceId, date, startHour, endHour) => state.bookings.filter(item => item.resourceId === resourceId
    && item.date === date && ['confirmed', 'checked_in'].includes(item.status) && item.startHour < endHour && item.endHour > startHour);
  function getBooking(state, id) {
    const booking = state.bookings.find(item => item.id === id);
    if (!booking) fail(404, 'NOT_FOUND', 'Booking was not found.');
    return booking;
  }
  function receipt(state, actor, type, input, apply) {
    object(input);
    const id = opId(input.operationId), {operationId, ...payload} = input;
    const fingerprint = stable({type, payload}), previous = state.receipts.find(item => item.id === id);
    if (previous) {
      if (previous.userId !== actor.id || previous.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'This operation ID has already been used for a different request.');
      return copy(previous.data);
    }
    const result = apply(payload);
    state.receipts.push({id, userId: actor.id, fingerprint, data: copy(result), createdAt: stamp()});
    state.revision++;
    return result;
  }
  function book(state, actor, input) {
    requireRole(actor, ...ROLES);
    return receipt(state, actor, 'booking', input, payload => {
      const resourceId = text(payload.resourceId, 'Resource', 40), date = text(payload.date, 'Date', 10);
      const resource = state.resources.find(item => item.id === resourceId);
      if (!resource) fail(404, 'NOT_FOUND', 'Choose an available resource.');
      if (!validDate(date)) fail(400, 'VALIDATION', 'Choose a valid date.');
      const startHour = int(payload.startHour, 'Start hour', 8, 21), endHour = int(payload.endHour, 'End hour', 9, 22);
      const starts = startsAt({date, startHour});
      if (endHour <= startHour || starts < Date.now() || starts > Date.now() + 180 * 86400000) fail(400, 'VALIDATION', 'Choose a future booking of at least one hour within 180 days.');
      if (overlapping(state, resourceId, date, startHour, endHour).length) fail(409, 'BOOKING_CONFLICT', 'This space is already reserved during the selected time.');
      const id = uniqueId();
      const booking = {id, reference: `CL-${id.slice(0, 8).toUpperCase()}`, resourceId, customerId: actor.role === 'customer' ? actor.id : null,
        customerName: actor.role === 'customer' ? actor.name : payload.customerName ? text(payload.customerName, 'Customer name', 100) : 'Walk-in guest',
        date, startHour, endHour, total: (endHour - startHour) * resource.rate, status: 'confirmed', paid: false, version: 1};
      state.bookings.push(booking);
      audit(state, actor, 'booking.create', booking.reference);
      return booking;
    });
  }
  function sell(state, actor, input) {
    requireRole(actor, 'employee', 'owner');
    return receipt(state, actor, 'sale', input, payload => {
      if (payload.method !== 'cash') fail(400, 'VALIDATION', 'Only cash payments are supported.');
      if (!Array.isArray(payload.items) || payload.items.length > 30) fail(400, 'VALIDATION', 'Choose at most 30 product lines.');
      const seen = new Set(), items = [];
      let total = 0, booking;
      for (const line of payload.items) {
        object(line);
        const id = text(line.productId, 'Product', 40), quantity = int(line.quantity, 'Quantity', 1, 100);
        if (seen.has(id)) fail(400, 'VALIDATION', 'Each product may appear only once.');
        seen.add(id);
        const product = state.products.find(item => item.id === id);
        if (!product) fail(404, 'NOT_FOUND', 'Product was not found.');
        if (product.stock < quantity) fail(409, 'OUT_OF_STOCK', `${product.name} does not have enough stock.`);
        items.push({productId: id, productName: product.name, unitPrice: product.price, name: product.name, price: product.price, quantity, total: product.price * quantity});
        total += product.price * quantity;
      }
      if (payload.bookingId) {
        booking = getBooking(state, text(payload.bookingId, 'Booking', 80));
        const version = int(payload.bookingVersion, 'Booking version', 1, 2147483647);
        if (booking.version !== version) fail(409, 'STALE_VERSION', 'This booking changed. Refresh and review before collecting payment.');
        if (booking.paid) fail(409, 'ALREADY_PAID', 'This booking has already been paid.');
        if (['cancelled', 'completed'].includes(booking.status)) fail(409, 'INVALID_BOOKING', 'This booking cannot be collected.');
        items.push({bookingId: booking.id, productName: `Booking ${booking.reference}`, unitPrice: booking.total, name: `Booking ${booking.reference}`, price: booking.total, quantity: 1, total: booking.total});
        total += booking.total;
      }
      if (!items.length) fail(400, 'VALIDATION', 'Add a product or an unpaid booking.');
      const tendered = int(payload.tendered, 'Cash tendered', 0, 100000000);
      if (tendered < total) fail(409, 'INSUFFICIENT_CASH', 'Cash tendered is below the total.');
      // All checks precede stock/payment changes, including during a sync batch.
      for (const item of items) if (item.productId) state.products.find(product => product.id === item.productId).stock -= item.quantity;
      if (booking) { booking.paid = true; booking.version++; }
      const id = uniqueId(), result = {id, reference: `TX-${id.slice(0, 8).toUpperCase()}`, total, tendered, change: tendered - total, method: 'cash', createdAt: stamp(), items};
      state.sales.push(result);
      audit(state, actor, 'sale.create', `${result.reference}: ${total} centavos`);
      return result;
    });
  }
  function snapshot(state, actor) {
    const customer = actor.role === 'customer', owner = actor.role === 'owner';
    return {user: actor, revision: state.revision, serverTime: stamp(), demo: true, localDemo: true,
      resources: [...state.resources].sort((a, b) => b.type.localeCompare(a.type) || a.id.localeCompare(b.id)),
      bookings: state.bookings.filter(item => !customer || item.customerId === actor.id).sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour),
      products: [...state.products].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
      sales: customer ? [] : [...state.sales].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      employees: owner ? state.users.filter(item => item.role === 'employee').sort((a, b) => a.name.localeCompare(b.name))
        .map(item => ({...publicUser(item), active: item.active, createdAt: item.createdAt})) : [],
      jobs: [...state.jobs].sort((a, b) => a.title.localeCompare(b.title)),
      applications: customer ? state.applications.filter(item => item.customerId === actor.id) : owner ? [...state.applications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [],
      audit: owner ? [...state.audit].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200) : []};
  }
  async function createAccount(state, input, actor) {
    object(input);
    const name = text(input.name, 'Name', 100), address = email(input.email), pass = password(input.password);
    if (state.users.some(item => item.email === address)) fail(409, 'EMAIL_EXISTS', 'An account already uses that email.');
    const passwordHash = await hashPassword(pass), id = uniqueId(), role = actor ? 'employee' : 'customer';
    state.users.push({id, name, email: address, role, active: true, passwordHash, createdAt: stamp()});
    audit(state, actor || {id, name}, actor ? 'employee.create' : 'customer.register', actor ? address : 'Customer account created');
    state.revision++;
    return {ok: true};
  }
  async function dispatch(state, route, input) {
    if (typeof route !== 'string' || !route.startsWith('/')) fail(404, 'NOT_FOUND', 'API route was not found.');
    const [path, query = ''] = route.split('?');
    if (path === '/login') {
      object(input);
      const role = text(input.role, 'Role', 20), client = input.client ?? 'browser';
      if (!ROLES.includes(role)) fail(400, 'VALIDATION', 'Choose a valid account role.');
      if (!['browser', 'native'].includes(client)) fail(400, 'VALIDATION', 'Invalid client.');
      if (client === 'native' && role !== 'owner') fail(403, 'FORBIDDEN', 'The continuity app is for Owner accounts only.');
      let address = text(input.email, 'Email', 254).toLowerCase();
      if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 128) fail(400, 'VALIDATION', 'Enter your password.');
      if (address === '1234') address = {owner: 'owner@clinch.local', employee: 'employee@clinch.local', customer: 'alex@clinch.local'}[role];
      const user = state.users.find(item => item.email === address);
      if (!user || !user.active || user.role !== role || !(await verifyPassword(input.password, user))) fail(401, 'INVALID_CREDENTIALS', 'Email, password, or selected role is incorrect.');
      state.session = {userId: user.id, csrf: uniqueId(), expires: Date.now() + SESSION_MS};
      audit(state, user, 'session.login', `${client} local demo login`);
      return {...session(state), ...(client === 'native' ? {token: uniqueId()} : {})};
    }
    if (path === '/register') return createAccount(state, input);
    if (path === '/logout') { state.session = null; return {ok: true}; }
    const authenticated = session(state), actor = authenticated.user;
    if (path === '/session') return authenticated;
    if (path === '/snapshot') return snapshot(state, actor);
    if (path === '/availability') {
      const params = new URLSearchParams(query), date = text(params.get('date'), 'Date', 10);
      const startHour = int(Number(params.get('startHour')), 'Start hour', 8, 21), endHour = int(Number(params.get('endHour')), 'End hour', 9, 22);
      if (!validDate(date) || endHour <= startHour) fail(400, 'VALIDATION', 'Choose a valid date and time range.');
      return {availability: [...state.resources].sort((a, b) => a.id.localeCompare(b.id)).map(resource => {
        const overlaps = overlapping(state, resource.id, date, startHour, endHour);
        return {resourceId: resource.id, status: overlaps.some(item => item.status === 'checked_in') ? 'occupied' : overlaps.length ? 'reserved' : 'available'};
      })};
    }
    if (path === '/bookings') return book(state, actor, input);
    const bookingStatus = path.match(/^\/bookings\/([^/]+)\/status$/);
    if (bookingStatus) {
      object(input);
      const status = text(input.status, 'Status', 30), version = int(input.version, 'Version', 1, 2147483647);
      const booking = getBooking(state, decodeURIComponent(bookingStatus[1]));
      if (booking.version !== version) fail(409, 'STALE_VERSION', 'This booking changed. Refresh and review it.');
      if (actor.role === 'customer' && (booking.customerId !== actor.id || status !== 'cancelled' || booking.status !== 'confirmed' || startsAt(booking) <= Date.now() || booking.paid)) {
        fail(403, 'FORBIDDEN', 'Only your future unpaid confirmed bookings can be cancelled.');
      }
      const allowed = {confirmed: ['checked_in', 'cancelled'], checked_in: ['completed'], completed: [], cancelled: []};
      if (!allowed[booking.status]?.includes(status)) fail(409, 'INVALID_TRANSITION', 'This booking status change is not allowed.');
      if (status === 'cancelled' && booking.paid) fail(409, 'PAID_BOOKING', 'Paid bookings cannot be cancelled. Contact the owner.');
      if (status === 'completed' && !booking.paid) fail(409, 'UNPAID_BOOKING', 'Collect the booking payment before completing it.');
      booking.status = status;
      booking.version++;
      audit(state, actor, 'booking.status', `${booking.reference}: ${status}`);
      state.revision++;
      return booking;
    }
    if (path === '/sales') return sell(state, actor, input);
    if (path === '/employees') { requireRole(actor, 'owner'); return createAccount(state, input, actor); }
    const employeeStatus = path.match(/^\/employees\/([^/]+)\/status$/);
    if (employeeStatus) {
      requireRole(actor, 'owner');
      object(input);
      if (typeof input.active !== 'boolean') fail(400, 'VALIDATION', 'Active must be true or false.');
      const target = state.users.find(item => item.id === decodeURIComponent(employeeStatus[1]));
      if (!target) fail(404, 'NOT_FOUND', 'Employee was not found.');
      if (target.role !== 'employee') fail(403, 'FORBIDDEN', 'Only employee accounts may be enabled or disabled.');
      target.active = input.active;
      audit(state, actor, 'employee.status', `${target.email}: ${input.active ? 'active' : 'disabled'}`);
      state.revision++;
      return {ok: true};
    }
    if (path === '/applications') {
      requireRole(actor, 'customer');
      object(input);
      const jobId = text(input.jobId, 'Opening', 80), message = text(input.message, 'Application', 2000);
      if (!state.jobs.some(item => item.id === jobId && item.open)) fail(404, 'NOT_FOUND', 'This opening is not accepting applications.');
      if (state.applications.some(item => item.jobId === jobId && item.customerId === actor.id)) fail(409, 'ALREADY_APPLIED', 'You have already applied for this opening.');
      state.applications.push({id: uniqueId(), jobId, customerId: actor.id, customerName: actor.name, message, createdAt: stamp()});
      audit(state, actor, 'application.create', jobId);
      state.revision++;
      return {ok: true};
    }
    if (path === '/jobs') {
      requireRole(actor, 'owner');
      object(input);
      const title = text(input.title, 'Title', 120), type = text(input.type, 'Employment type', 60), description = text(input.description, 'Description', 2000);
      state.jobs.push({id: uniqueId(), title, type, description, open: true});
      audit(state, actor, 'job.create', title);
      state.revision++;
      return {ok: true};
    }
    if (path === '/sync') {
      requireRole(actor, 'owner');
      object(input);
      if (!Array.isArray(input.operations) || input.operations.length > 50) fail(400, 'VALIDATION', 'A sync attempt accepts at most 50 operations.');
      const results = [];
      for (const operation of input.operations) {
        const id = typeof operation?.id === 'string' ? operation.id : '';
        try {
          object(operation);
          opId(id);
          object(operation.payload);
          if (!['booking', 'sale'].includes(operation.type)) fail(400, 'VALIDATION', 'Unknown operation type.');
          // Each operation has its own atomic boundary; one conflict cannot roll back accepted work.
          const candidate = copy(state), payload = {...operation.payload, operationId: id};
          const data = operation.type === 'booking' ? book(candidate, actor, payload) : sell(candidate, actor, payload);
          Object.assign(state, candidate);
          results.push({id, status: 'accepted', data});
        } catch (error) {
          if (!error.status) throw error;
          results.push({id, status: error.status === 409 ? 'conflict' : 'rejected', error: error.message, code: error.code});
        }
      }
      return {results, revision: state.revision, demo: true, localDemo: true};
    }
    fail(404, 'NOT_FOUND', 'API route was not found.');
  }
  function request(path, body) {
    // Serialize changes so rapid clicks never spend the same stock/payment twice.
    const run = queue.then(async () => {
      const state = readState();
      const result = await dispatch(state, path, body === undefined ? undefined : copy(body));
      saveState(state);
      return copy(result);
    });
    queue = run.catch(() => {});
    return run;
  }
  globalThis.ClinchDemo = Object.freeze({request, enabled: true});
})();
