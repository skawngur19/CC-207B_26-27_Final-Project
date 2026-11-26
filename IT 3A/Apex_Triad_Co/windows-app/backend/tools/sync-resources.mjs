// backend/tools/sync-resources.mjs
// Makes the website's Firestore `resources` match the app's (SQLite) resources:
//   - creates resources that exist only in the app
//   - corrects id/name/type/capacity/rate where an id exists on both sides
//   - lists resources that exist only on the website, and says whether any
//     booking or slot lock still uses them
// Dry run by default: it prints the plan and writes nothing.
//   cd backend
//   $env:CLINCH_DB = "$PWD\data\clinch-connected-demo.sqlite"
//   node tools\sync-resources.mjs                         (dry run)
//   $env:CLINCH_RESOURCES_LIVE = "1"; node tools\sync-resources.mjs
//   $env:CLINCH_RESOURCES_DELETE = "1"  (with LIVE) also deletes website-only
//                                       resources that nothing uses
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const dbPath = resolve(process.env.CLINCH_DB ?? 'data/clinch.sqlite');
const live = process.env.CLINCH_RESOURCES_LIVE === '1';
const allowDelete = process.env.CLINCH_RESOURCES_DELETE === '1';

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

const db = await openDb(dbPath);
db.exec('PRAGMA busy_timeout=5000');
const rows = db.prepare('SELECT id,name,type,capacity,rate FROM resources ORDER BY id').all().map(r => ({ ...r }));
db.close();

if (!rows.length) {
  console.error('The app has no resources, so there is nothing to copy.');
  process.exit(1);
}
const bad = rows.filter(r => typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.type !== 'string' ||
  !Number.isInteger(r.capacity) || !Number.isInteger(r.rate) || r.rate < 0);
if (bad.length) {
  console.error('These app resources have a missing or invalid field:', bad.map(r => r.id).join(', '));
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: 'clinch-demo' });
const firestore = getFirestore();
const web = new Map((await firestore.collection('resources').get()).docs.map(d => [d.id, d.data()]));
const app = new Map(rows.map(r => [r.id, r]));
const fields = ['id', 'name', 'type', 'capacity', 'rate'];

const toCreate = rows.filter(r => !web.has(r.id));
const toUpdate = rows.filter(r => web.has(r.id) && fields.some(f => web.get(r.id)[f] !== r[f]));
const extras = [];
for (const id of web.keys()) {
  if (app.has(id)) continue;
  const usedBy = [];
  for (const name of ['bookings', 'slotLocks']) {
    const found = await firestore.collection(name).where('resourceId', '==', id).limit(1).get();
    if (!found.empty) usedBy.push(name);
  }
  extras.push({ id, usedBy });
}
const deletable = extras.filter(e => !e.usedBy.length);

const line = r => `${r.id} (${r.name}, ${r.type}, capacity ${r.capacity}, rate ${r.rate})`;
console.log(`${live ? 'LIVE' : 'DRY RUN'}: app has ${app.size} resources, website has ${web.size}.`);
console.log(`\nCreate on the website (${toCreate.length}):` + (toCreate.length ? '\n  ' + toCreate.map(line).join('\n  ') : ' none'));
console.log(`\nCorrect on the website (${toUpdate.length}):`);
for (const r of toUpdate) {
  const w = web.get(r.id);
  console.log(`  ${r.id}: ` + fields.filter(f => w[f] !== r[f]).map(f => `${f} ${JSON.stringify(w[f])} -> ${JSON.stringify(r[f])}`).join(', '));
}
if (!toUpdate.length) console.log('  none');
console.log(`\nOnly on the website (${extras.length}):`);
for (const e of extras) {
  console.log(`  ${e.id}: ` + (e.usedBy.length ? `IN USE by ${e.usedBy.join(' and ')}, will not be deleted` : 'not used by any booking or slot lock'));
}
if (!extras.length) console.log('  none');

if (!live) {
  console.log('\nNothing was written. Set CLINCH_RESOURCES_LIVE=1 to apply. Add CLINCH_RESOURCES_DELETE=1 to also remove the unused website-only resources.');
  process.exit(0);
}

const batch = firestore.batch();
for (const r of toCreate) batch.create(firestore.doc(`resources/${r.id}`), r);
for (const r of toUpdate) batch.update(firestore.doc(`resources/${r.id}`), r);
if (allowDelete) for (const e of deletable) batch.delete(firestore.doc(`resources/${e.id}`));
await batch.commit();
console.log(`\nDone: created ${toCreate.length}, corrected ${toUpdate.length}, deleted ${allowDelete ? deletable.length : 0}.`);
if (!allowDelete && deletable.length) console.log(`Not deleted (needs CLINCH_RESOURCES_DELETE=1): ${deletable.map(e => e.id).join(', ')}`);
process.exit(0);