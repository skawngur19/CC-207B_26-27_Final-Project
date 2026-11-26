// backend/tools/compare-resources.mjs
// Read-only check: compares the app's resources (local SQLite) with the website's
// resources (Firestore, project clinch-demo). Changes nothing on either side.
//   cd backend
//   $env:CLINCH_DB = "$PWD\data\clinch-connected-demo.sqlite"
//   node tools\compare-resources.mjs
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const dbPath = resolve(process.env.CLINCH_DB ?? 'data/clinch.sqlite');
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
const app = new Map(db.prepare('SELECT id,name,type,capacity,rate FROM resources ORDER BY id').all()
  .map(r => [r.id, { ...r }]));
db.close();

initializeApp({ credential: applicationDefault(), projectId: 'clinch-demo' });
const snap = await getFirestore().collection('resources').get();
const web = new Map(snap.docs.map(d => [d.id, d.data()]));

const fields = ['name', 'type', 'capacity', 'rate'];
const onlyApp = [...app.keys()].filter(id => !web.has(id));
const onlyWeb = [...web.keys()].filter(id => !app.has(id));
const differences = [];
for (const [id, a] of app) {
  const w = web.get(id);
  if (!w) continue;
  for (const f of fields) {
    if (a[f] !== w[f]) differences.push(`  ${id}.${f}: app=${JSON.stringify(a[f])}  website=${JSON.stringify(w[f])}`);
  }
}

console.log(`App (SQLite): ${app.size} resources.   Website (Firestore): ${web.size} resources.`);
if (onlyApp.length) console.log(`\nOnly in the app (${onlyApp.length}):\n  ${onlyApp.join(', ')}`);
if (onlyWeb.length) console.log(`\nOnly on the website (${onlyWeb.length}):\n  ${onlyWeb.join(', ')}`);
if (differences.length) console.log(`\nSame id, different values (${differences.length}):\n${differences.join('\n')}`);
if (!onlyApp.length && !onlyWeb.length && !differences.length) {
  console.log('\nAll resources match: same ids, names, types, capacities and rates.');
}
process.exit(0);