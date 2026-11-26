// backend/tools/seed-products-from-firestore.mjs
// One-time: copies the website's products (Firestore, project clinch-demo) into
// the local SQLite database, so the Windows app and the local site show the
// same menu, prices and stock. Reads Firestore only; never writes to it.
// Refuses to run if the local products table already has rows, so it can
// never overwrite stock after sales have started.
//   cd backend
//   $env:CLINCH_DB = "$PWD\data\clinch-connected-demo.sqlite"
//   node tools\seed-products-from-firestore.mjs
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

initializeApp({ credential: applicationDefault(), projectId: 'clinch-demo' });
const snap = await getFirestore().collection('products').get();
const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
if (!products.length) {
  console.error('Firestore has no products. Nothing to copy.');
  process.exit(1);
}

const bad = products.filter(p =>
  typeof p.name !== 'string' || typeof p.category !== 'string' ||
  !Number.isInteger(p.price) || p.price < 0 || !Number.isInteger(p.stock) || p.stock < 0);
if (bad.length) {
  console.error('These Firestore products have a missing or invalid field:', bad.map(p => p.id).join(', '));
  process.exit(1);
}

const db = await openDb(dbPath);
db.exec('PRAGMA busy_timeout=5000');
const existing = Number(db.prepare('SELECT COUNT(*) AS n FROM products').get().n);
if (existing > 0) {
  console.log(`The local database already has ${existing} product(s). Nothing changed.`);
  db.close();
  process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
try {
  const insert = db.prepare('INSERT INTO products(id,name,category,price,stock,version) VALUES(?,?,?,?,?,1)');
  for (const p of products) insert.run(p.id, p.name, p.category, p.price, p.stock);
  // Lets clients that watch the revision number notice the change.
  db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Copy failed, nothing was changed:', e.message);
  process.exit(1);
}

console.log(`Copied ${products.length} product(s) into ${dbPath}:`);
for (const p of products) console.log(`  ${p.id}: ${p.name}, price ${p.price} centavos, stock ${p.stock}`);
db.close();
process.exit(0);