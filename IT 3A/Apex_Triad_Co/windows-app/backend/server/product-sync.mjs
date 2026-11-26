// Copies only explicit product create/edit operations from SQLite to Firestore.
// In particular, ordinary sale stock reductions are not treated as product edits.
export function openProductSource(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS product_change_journal(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, productId TEXT NOT NULL, data TEXT NOT NULL)`);
  const page = db.prepare(
    'SELECT seq,productId,data FROM product_change_journal WHERE seq>? ORDER BY seq LIMIT 101');
  const cursor = () => Number(db.prepare(
    "SELECT value FROM meta WHERE key='productMirrorSeq'").get()?.value ?? 0);
  const save = db.prepare(
    "INSERT INTO meta(key,value) VALUES('productMirrorSeq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  return {
    read() {
      const rows = page.all(cursor());
      return {
        changes: rows.slice(0, 100).map(row => ({
          seq: row.seq, productId: row.productId, data: JSON.parse(row.data)
        })),
        more: rows.length > 100
      };
    },
    acknowledge(seq) {
      save.run(String(seq));
    }
  };
}

function sameFields(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export async function mirrorProductsToWebsite(source, firestore, { dryRun = true } = {}) {
  const batch = source.read();
  if (dryRun) {
    return {
      changes: batch.changes.length,
      more: batch.more,
      preview: batch.changes[0] ?? null
    };
  }

  let copied = 0;
  for (const change of batch.changes) {
    const ref = firestore.doc(`products/${change.productId}`);
    await firestore.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (Object.hasOwn(change.data, 'id')) {
        if (current.exists) {
          if (sameFields(current.data(), change.data)) return;
          throw new Error(`Product ${change.productId} already exists on the website with different data.`);
        }
        tx.create(ref, change.data);
        return;
      }
      if (!current.exists) {
        throw new Error(`Product ${change.productId} is missing from the website; app edit was not copied.`);
      }
      tx.update(ref, change.data);
    });
    source.acknowledge(change.seq);
    copied++;
  }
  return { changes: copied, more: batch.more, preview: null };
}
