// backend/server/clinch-sync.mjs
// The one runner that keeps the app and the website in step:
//   sales and exact stock           both ways        (website-sales-sync.mjs)
//   product creates/edits           app -> website   (product-sync.mjs)
//   bookings and slot locks         both ways        (booking-sync.mjs)
// Dry run by default: prints what it WOULD change and writes nothing.
// Environment:
//   CLINCH_DB                      path to the SQLite file the server uses
//   CLINCH_SYNC_LIVE=1             actually write (to Firestore and to the app's database)
//   CLINCH_SYNC_ONCE=1             with LIVE: do one pass and exit
//   CLINCH_FIREBASE_OPERATOR_UID   Firebase UID of the owner, put on synced sales and log entries
//   CLINCH_MIRROR_SECONDS          seconds between passes (default 15, minimum 5)
// Credentials come from `gcloud auth application-default login`. No key file.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldPath, FieldValue } from 'firebase-admin/firestore';
import { openWebsiteSource, mirrorToWebsite } from './website-mirror.mjs';
import { openProductSource, mirrorProductsToWebsite } from './product-sync.mjs';
import { importWebsiteSales, syncWebsiteStockToApp } from './website-sales-sync.mjs';
import { planBookingSync, applyToWeb, applyToApp, SyncConflict } from './booking-sync.mjs';

const dbPath = resolve(process.env.CLINCH_DB ?? 'data/clinch.sqlite');
const live = process.env.CLINCH_SYNC_LIVE === '1';
const once = process.env.CLINCH_SYNC_ONCE === '1';
const operatorUid = process.env.CLINCH_FIREBASE_OPERATOR_UID || undefined;
const seconds = Math.max(5, Number(process.env.CLINCH_MIRROR_SECONDS ?? 15));

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}\nSet CLINCH_DB to the file the server uses.`);
  process.exit(1);
}

async function openDb(path) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path);
  } catch {
    const { default: Database } = await import('better-sqlite3');
    return new Database(path);
  }
}

initializeApp({ credential: applicationDefault(), projectId: 'clinch-demo' });
const firestore = getFirestore();
const db = await openDb(dbPath);
db.exec('PRAGMA busy_timeout=5000');
db.exec('PRAGMA foreign_keys=ON');
const source = openWebsiteSource(db);
const productSource = openProductSource(db);

// ---- bookings: a local copy of the website's bookings
const fromWeb = (id, d) => ({
  id, reference: d.reference, resourceId: d.resourceId, customerName: d.customerName ?? 'Website guest',
  date: d.date, startHour: d.startHour, endHour: d.endHour, total: d.total, status: d.status,
  paid: Boolean(d.paid), version: d.version ?? 1
});
const appBookings = () => db.prepare(
  'SELECT id,reference,resourceId,customerName,date,startHour,endHour,total,status,paid,version FROM bookings'
).all().map(r => ({ ...r, paid: Boolean(r.paid) }));

// Live mode keeps the copy up to date with a listener (almost no Firestore reads).
// Dry run reads once.
const web = new Map();
if (live) {
  await new Promise((ready, fail) => {
    let first = true;
    firestore.collection('bookings').onSnapshot(snap => {
      for (const change of snap.docChanges()) {
        if (change.type === 'removed') web.delete(change.doc.id);
        else web.set(change.doc.id, fromWeb(change.doc.id, change.doc.data()));
      }
      if (first) { first = false; ready(); }
    }, error => { console.error('Lost the Firestore listener:', error.message); fail(error); });
  });
} else {
  for (const doc of (await firestore.collection('bookings').get()).docs) web.set(doc.id, fromWeb(doc.id, doc.data()));
}

const reported = new Set();
const reportOnce = (key, text) => { if (!reported.has(key)) { reported.add(key); console.error(text); } };
let appSalesSynced = false;
let appProductsSynced = false;

const describe = a => {
  const b = a.booking;
  return `${a.type} ${b.reference} (${b.resourceId} ${b.date} ${b.startHour}-${b.endHour}` +
    (a.status ? `, ${a.status}${a.paid ? ', paid' : ''}` : `, ${b.status}`) + ')';
};

// ---- one pass of sales, stock and activity log (app -> website)
async function salesRound() {
  appSalesSynced = false;
  for (let page = 0; page < 50; page++) {
    const result = await mirrorToWebsite(source, firestore, {
      dryRun: !live,
      increment: n => FieldValue.increment(n),
      operatorUid
    });
    if (!live) {
      console.log(result.sales
        ? `Sales: would copy ${result.sales} sale(s). Stock change: ${JSON.stringify(result.stock)}`
        : 'Sales: nothing new to copy.');
      if (result.missing?.length) console.log('  NOT FOUND in Firestore products:', result.missing.join(', '));
      if (result.preview) console.log('  First sale as the website would get it:\n' + JSON.stringify(result.preview, null, 2).replace(/^/gm, '  '));
      appSalesSynced = true;
      return;
    }
    if (result.sales) console.log(`Sales: copied ${result.sales} sale(s). Stock change: ${JSON.stringify(result.stock)}`);
    if (!result.more) {
      appSalesSynced = true;
      return;
    }
  }
}

// ---- website cash sales -> app history; website stock remains authoritative
async function websiteSalesRound() {
  for (let page = 0; page < 50; page++) {
    const result = await importWebsiteSales(db, firestore, {
      dryRun: !live,
      documentId: FieldPath.documentId()
    });
    if (!live) {
      console.log(result.sales
        ? `Website sales: would import ${result.sales} sale(s).`
        : 'Website sales: nothing new to import.');
      if (result.preview) console.log('  First website sale:\n' + JSON.stringify(result.preview, null, 2).replace(/^/gm, '  '));
      return;
    }
    if (result.sales) console.log(`Website sales: imported ${result.sales} sale(s).`);
    if (!result.more) return;
  }
}

// ---- app product creates/edits -> website
async function productsRound() {
  appProductsSynced = false;
  for (let page = 0; page < 50; page++) {
    const result = await mirrorProductsToWebsite(productSource, firestore, { dryRun: !live });
    if (!live) {
      console.log(result.changes
        ? `Products: would copy ${result.changes} change(s). First: ${JSON.stringify(result.preview)}`
        : 'Products: nothing new to copy.');
      appProductsSynced = true;
      return;
    }
    if (result.changes) console.log(`Products: copied ${result.changes} change(s).`);
    if (!result.more) {
      appProductsSynced = true;
      return;
    }
  }
}

// Pull only the website's authoritative stock values, never stale app stock.
async function stockRound() {
  if (live && (!appSalesSynced || !appProductsSynced)) {
    console.log('Stock: skipped because pending app sales or product edits remain.');
    return;
  }
  const result = await syncWebsiteStockToApp(db, firestore, { dryRun: !live });
  if (result.updated.length) {
    const summary = Object.fromEntries(result.updated.map(p => [p.id, p.stock]));
    console.log(`Stock: ${live ? 'updated' : 'would update'} app counts from website: ${JSON.stringify(summary)}`);
  } else console.log('Stock: app counts already match the website.');
  if (result.missing.length) console.log('  Website products not in the app:', result.missing.join(', '));
}

// ---- one pass of bookings (both ways)
async function bookingsRound() {
  const app = appBookings();
  const { actions, conflicts } = planBookingSync(app, [...web.values()]);
  if (!live) {
    console.log(`Bookings: ${app.length} in the app, ${web.size} on the website.`);
    console.log(`  Would change (${actions.length}):` + (actions.length ? '\n    ' + actions.map(describe).join('\n    ') : ' nothing'));
    console.log(`  Needs a person (${conflicts.length}):` + (conflicts.length ? '\n    ' + conflicts.map(c => `${c.reference}: ${c.why}`).join('\n    ') : ' nothing'));
    return;
  }
  for (const action of actions) {
    try {
      const outcome = action.type.endsWith('Web')
        ? await applyToWeb(firestore, action, { operatorUid })
        : applyToApp(db, action);
      if (outcome === 'done') console.log('Bookings: done:', describe(action));
    } catch (error) {
      const kind = error instanceof SyncConflict ? 'CONFLICT' : 'ERROR';
      reportOnce(`${action.type}:${action.booking.id}:${error.message}`, `Bookings: ${kind} ${describe(action)} - ${error.message}`);
    }
  }
  for (const c of conflicts) reportOnce(`plan:${c.id}:${c.why}`, `Bookings: NEEDS A PERSON ${c.reference}: ${c.why}`);
}

// A problem in one part never blocks the other.
async function pass() {
  for (const [name, round] of [
    ['Website sales', websiteSalesRound],
    ['Products', productsRound],
    ['App sales', salesRound],
    ['Stock', stockRound],
    ['Bookings', bookingsRound]
  ]) {
    try { await round(); } catch (e) { reportOnce(`${name}:${e.message}`, `${name} stopped this pass: ${e.message}`); }
  }
}

if (!live) {
  await pass();
  console.log('\nDry run finished. Nothing was written. Set CLINCH_SYNC_LIVE=1 to write.');
  db.close();
  process.exit(0);
}

console.log(`LIVE: ${dbPath} <-> Firestore clinch-demo (sales, products, stock and bookings, every ${seconds}s). Press Ctrl+C to stop.`);
let busy = false;
const run = async () => {
  if (busy) return;
  busy = true;
  try { await pass(); } finally { busy = false; }
};
await run();
if (once) { db.close(); process.exit(0); }
const timer = setInterval(run, seconds * 1000);
const stop = () => { clearInterval(timer); db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);