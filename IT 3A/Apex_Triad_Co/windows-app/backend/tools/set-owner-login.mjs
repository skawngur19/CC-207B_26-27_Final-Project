// backend/tools/set-owner-login.mjs
// Makes the app's Owner login the same email and password as the website's owner.
// It changes only the owner's email and password hash in the app's local database
// (same scrypt settings as service.mjs). Nothing is written to Firebase.
// The password is typed at the prompt (hidden). It is never put in a file, an
// environment variable, or the command line.
//   cd backend
//   $env:CLINCH_DB = "$PWD\data\clinch-connected-demo.sqlite"
//   $env:CLINCH_FIREBASE_API_KEY = "<apiKey from the website's firebase-config.js>"   (optional, recommended)
//   node tools\set-owner-login.mjs
// With the API key set, the tool first checks that Firebase accepts the email and
// password and that the account is the website's owner. Without it, nothing is verified.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const dbPath = resolve(process.env.CLINCH_DB ?? 'data/clinch.sqlite');
const apiKey = process.env.CLINCH_FIREBASE_API_KEY || '';
const stop = message => { console.error(message); process.exit(1); };

if (!existsSync(dbPath)) stop(`Database not found: ${dbPath}\nSet CLINCH_DB to the file the server uses.`);

async function readAllInput() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/);
}

function askHidden(prompt) {
  return new Promise(done => {
    process.stdout.write(prompt);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return done(value);
        }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

function askVisible(prompt) {
  return new Promise(done => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', chunk => { process.stdin.pause(); done(String(chunk).trim()); });
  });
}

let email, password;
if (process.stdin.isTTY) {
  email = await askVisible('Website owner email: ');
  password = await askHidden('Website owner password (hidden): ');
  const again = await askHidden('Type the password again: ');
  if (again !== password) stop('The two passwords differ. Nothing was changed.');
} else {
  [email, password] = await readAllInput(); // used for automated tests only
}

email = String(email ?? '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) stop('Enter a valid email address. Nothing was changed.');
if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
  stop('The password must contain 12 to 128 characters. Nothing was changed.');
}

// ---- optional: confirm this really is the website's owner login
let uid = null;
if (apiKey) {
  let response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
  } catch (error) {
    stop(`Could not reach Firebase to check the login (${error.cause?.code ?? error.message}). Check the internet connection. Nothing was changed.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) stop(`Firebase did not accept that email and password (${data.error?.message ?? response.status}). Nothing was changed.`);
  uid = data.localId;
  try {
    const { initializeApp, applicationDefault } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    initializeApp({ credential: applicationDefault(), projectId: 'clinch-demo' });
    const profile = await getFirestore().doc(`users/${uid}`).get();
    if (!profile.exists || profile.data().role !== 'owner') stop('That account is not the website owner (its role is not "owner"). Nothing was changed.');
  } catch (error) {
    stop(`Could not check the account role in Firestore: ${error.message}\nRun "gcloud auth application-default login" and try again. Nothing was changed.`);
  }
  console.log('Firebase accepted the login and it is the website owner.');
} else {
  console.log('Note: CLINCH_FIREBASE_API_KEY is not set, so this login was NOT checked against Firebase.');
}

// ---- same hashing as service.mjs
const salt = randomBytes(16).toString('hex');
const hash = await derive(password, salt, 64, { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 });
const encoded = `scrypt$16384$8$5$${salt}$${hash.toString('hex')}`;

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
db.exec('BEGIN IMMEDIATE');
try {
  const owner = db.prepare("SELECT id FROM users WHERE role='owner'").get();
  if (!owner) throw new Error('The app database has no owner account yet. Start the server once first.');
  const clash = db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email, owner.id);
  if (clash) throw new Error('Another account in the app already uses that email.');
  db.prepare('UPDATE users SET email=?, password=? WHERE id=?').run(email, encoded, owner.id);
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(randomUUID(), owner.id, 'Owner', 'owner.login.change',
    'Owner login set to match the website (set-owner-login tool)', new Date().toISOString());
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  stop(`${error.message} Nothing was changed.`);
}
db.close();

console.log(`\nDone. Sign in to the app with ${email} and the password you just typed.`);
console.log('Sign out of the app first if it is still open, because the old session stays valid until it expires.');
console.log('"View Connected Demo Login.cmd" will still show the old generated login. Ignore it.');
if (uid) {
  console.log(`\nYour Firebase owner UID is ${uid}.`);
  console.log(`To tag synced sales with it, run once:  setx CLINCH_FIREBASE_OPERATOR_UID ${uid}`);
  console.log('Then close and reopen the sync window.');
}
process.exit(0);