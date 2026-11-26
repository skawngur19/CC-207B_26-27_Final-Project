// backend/server/booking-sync.mjs
// Keeps bookings in step between the app (SQLite) and the website (Firestore).
// Bookings share one id on both sides. Nothing is ever deleted; each change
// writes to exactly one side, and every write is guarded so a stale read
// is skipped and retried on the next pass.
//
// Rules:
//   - a booking that exists on one side only is copied to the other
//   - for a booking on both sides, the more advanced status wins
//     (confirmed < checked_in < completed), and paid = paid on either side
//   - cancelled vs checked_in/completed, cancelled vs paid, or a different
//     resource/time/total is NOT resolved automatically: it is reported
//   - the website's slotLocks are created/updated/removed to match status
//   - a copy that would double-book the other side is reported, not written
import { randomUUID } from 'node:crypto';

export const ACTIVE = new Set(['confirmed', 'checked_in']);
const RANK = { confirmed: 0, checked_in: 1, completed: 2, cancelled: 2 };
const SAME = ['resourceId', 'date', 'startHour', 'endHour', 'total'];

export class SyncConflict extends Error {}

export const lockId = (resourceId, date, hour) => `${resourceId}_${date}_${String(hour).padStart(2, '0')}`;
const hoursOf = b => Array.from({ length: b.endHour - b.startHour }, (_, i) => b.startHour + i);

function merge(a, w) {
  if (!(a.status in RANK) || !(w.status in RANK)) return { conflict: 'unknown booking status' };
  if (SAME.some(f => a[f] !== w[f])) return { conflict: 'the app and the website disagree on resource, time or total' };
  let status;
  if (a.status === w.status) status = a.status;
  else if (a.status === 'cancelled' || w.status === 'cancelled') {
    const other = a.status === 'cancelled' ? w : a;
    if (other.status !== 'confirmed') return { conflict: `cancelled on one side but ${other.status} on the other` };
    status = 'cancelled';
  } else status = RANK[a.status] >= RANK[w.status] ? a.status : w.status;
  const paid = Boolean(a.paid || w.paid);
  if (status === 'cancelled' && paid) return { conflict: 'cancelled on one side but paid on the other' };
  return { status, paid };
}

export function planBookingSync(appRows, webRows) {
  const app = new Map(appRows.map(b => [b.id, b]));
  const web = new Map(webRows.map(b => [b.id, b]));
  const actions = [], conflicts = [];
  for (const [id, a] of app) {
    const w = web.get(id);
    if (!w) { actions.push({ type: 'createWeb', booking: a }); continue; }
    const m = merge(a, w);
    if (m.conflict) { conflicts.push({ id, reference: a.reference, why: m.conflict }); continue; }
    if (m.status !== w.status || m.paid !== Boolean(w.paid)) actions.push({ type: 'updateWeb', booking: w, status: m.status, paid: m.paid });
    if (m.status !== a.status || m.paid !== Boolean(a.paid)) actions.push({ type: 'updateApp', booking: a, status: m.status, paid: m.paid });
  }
  for (const [id, w] of web) if (!app.has(id)) actions.push({ type: 'createApp', booking: w });
  return { actions, conflicts };
}

// Writes to Firestore. Returns 'done' or 'skipped'; throws SyncConflict.
export async function applyToWeb(firestore, action, { operatorUid, now = () => new Date().toISOString() } = {}) {
  const b = action.booking;
  const audit = (tx, name, detail) => tx.create(firestore.doc(`audit/${randomUUID()}`), {
    userId: operatorUid ?? 'owner', actor: 'Windows app', action: name, detail, createdAt: now()
  });
  return firestore.runTransaction(async tx => {
    const ref = firestore.doc(`bookings/${b.id}`);
    const snap = await tx.get(ref);

    if (action.type === 'createWeb') {
      if (snap.exists) return 'skipped';
      const locks = [];
      if (ACTIVE.has(b.status)) {
        for (const hour of hoursOf(b)) {
          const lockRef = firestore.doc(`slotLocks/${lockId(b.resourceId, b.date, hour)}`);
          if ((await tx.get(lockRef)).exists) {
            throw new SyncConflict(`${b.resourceId} on ${b.date} at ${hour}:00 is already reserved on the website`);
          }
          locks.push({ lockRef, hour });
        }
      }
      tx.create(ref, {
        id: b.id, reference: b.reference, resourceId: b.resourceId, customerId: null, customerName: b.customerName,
        date: b.date, startHour: b.startHour, endHour: b.endHour, total: b.total, status: b.status,
        paid: Boolean(b.paid), version: 1, source: 'windows', createdAt: now()
      });
      for (const { lockRef, hour } of locks) {
        tx.create(lockRef, { resourceId: b.resourceId, date: b.date, hour, status: b.status === 'checked_in' ? 'occupied' : 'reserved', bookingId: b.id });
      }
      audit(tx, 'booking.create', `${b.reference} (from the Windows app)`);
      return 'done';
    }

    // updateWeb: only if the website copy is still the version we planned from
    if (!snap.exists || snap.data().version !== b.version) return 'skipped';
    const cur = snap.data();
    for (const hour of hoursOf(cur)) {
      const lockRef = firestore.doc(`slotLocks/${lockId(cur.resourceId, cur.date, hour)}`);
      if (action.status === 'checked_in') {
        tx.set(lockRef, { resourceId: cur.resourceId, date: cur.date, hour, status: 'occupied', bookingId: cur.id });
      } else if (action.status === 'completed' || action.status === 'cancelled') {
        tx.delete(lockRef);
      }
    }
    tx.update(ref, { status: action.status, paid: action.paid, version: cur.version + 1, updatedAt: now() });
    if (cur.status !== action.status) audit(tx, 'booking.status', `${cur.reference}: ${action.status}`);
    return 'done';
  });
}

// Writes to SQLite. Returns 'done' or 'skipped'; throws SyncConflict.
export function applyToApp(db, action) {
  const b = action.booking;
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const stamp = new Date().toISOString();
  const audit = (name, detail) => run('INSERT INTO audit VALUES(?,?,?,?,?,?)', randomUUID(), 'sync', 'Website sync', name, detail, stamp);
  const bump = () => run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
  db.exec('BEGIN IMMEDIATE');
  try {
    let outcome = 'done';
    if (action.type === 'createApp') {
      if (get('SELECT 1 AS x FROM bookings WHERE id=?', b.id)) outcome = 'skipped';
      else {
        if (!get('SELECT 1 AS x FROM resources WHERE id=?', b.resourceId)) {
          throw new SyncConflict(`resource ${b.resourceId} does not exist in the app`);
        }
        if (ACTIVE.has(b.status) && get(
          "SELECT id FROM bookings WHERE resourceId=? AND date=? AND status IN ('confirmed','checked_in') AND startHour<? AND endHour>?",
          b.resourceId, b.date, b.endHour, b.startHour)) {
          throw new SyncConflict(`${b.resourceId} on ${b.date} ${b.startHour}-${b.endHour} overlaps another booking in the app`);
        }
        // customerId stays empty: website customers are not users in the app's database.
        run('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,?,?,?,1)', b.id, b.reference, b.resourceId, null,
          b.customerName ?? 'Website guest', b.date, b.startHour, b.endHour, b.total, b.status, b.paid ? 1 : 0);
        audit('booking.create', `${b.reference} (from the website)`);
        bump();
      }
    } else {
      const result = run('UPDATE bookings SET status=?,paid=?,version=version+1 WHERE id=? AND version=?',
        action.status, action.paid ? 1 : 0, b.id, b.version);
      if (!result.changes) outcome = 'skipped';
      else { audit('booking.status', `${b.reference}: ${action.status} (from the website)`); bump(); }
    }
    db.exec('COMMIT');
    return outcome;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}