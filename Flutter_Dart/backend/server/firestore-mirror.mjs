import { createHash, randomUUID } from 'node:crypto';

// The API remains the inventory authority. The Firebase copy contains settled
// sales and stock only. Never export sessions, grants or reconciliation secrets.
export function openMirrorSource(db) {
  const mode=db.prepare("SELECT value FROM meta WHERE key='demo'").get();
  const provider=db.prepare("SELECT value FROM meta WHERE key='authProvider'").get()?.value;
  if ((mode && mode.value!=='false') || !['local','firebase'].includes(provider)) {
    throw new Error('Use a connected-mode database for the Firestore mirror.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS firestore_journal(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, operationId TEXT NOT NULL UNIQUE, saleId TEXT NOT NULL UNIQUE);
      CREATE TRIGGER IF NOT EXISTS firestore_journal_sale AFTER INSERT ON receipts
      WHEN json_extract(NEW.data,'$.method')='cash'
      BEGIN
        INSERT INTO firestore_journal(operationId,saleId) VALUES(NEW.id,json_extract(NEW.data,'$.id'));
      END;`);
    if (!db.prepare("SELECT value FROM meta WHERE key='firestoreSourceId'").get()) {
      db.exec(`INSERT INTO firestore_journal(operationId,saleId)
        SELECT r.id,s.id FROM receipts r JOIN sales s ON s.id=json_extract(r.data,'$.id')
        ORDER BY s.rowid`);
      db.prepare("INSERT INTO meta VALUES('firestoreSourceId',?)").run(randomUUID());
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const sourceId = db.prepare("SELECT value FROM meta WHERE key='firestoreSourceId'").get().value;
  const page = db.prepare(`SELECT j.seq,j.operationId,s.*,t.shift,t.occurred
    FROM firestore_journal j JOIN sales s ON s.id=j.saleId
    LEFT JOIN terminal_ledger t ON t.saleId=s.id WHERE j.seq>? ORDER BY j.seq LIMIT 101`);
  const stock = db.prepare('SELECT id,name,price,stock FROM products ORDER BY id');
  const anchor = db.prepare('SELECT saleId FROM firestore_journal WHERE seq=?');
  const rev = db.prepare("SELECT value FROM meta WHERE key='revision'");
  return {
    sourceId,
    revision: () => Number(rev.get().value),
    read(checkpoint) {
      db.exec('BEGIN');
      try {
        if (checkpoint && (checkpoint.sourceId !== sourceId ||
            (checkpoint.seq && anchor.get(checkpoint.seq)?.saleId !== checkpoint.lastSaleId))) {
          throw new Error('The Firebase checkpoint belongs to a different database history.');
        }
        const seq = checkpoint?.seq ?? 0;
        const rows = page.all(seq), more = rows.length > 100;
        const sales = rows.slice(0, 100).map(s => ({...s, items: JSON.parse(s.items)}));
        const last = sales.at(-1);
        const revision = Number(rev.get().value);
        if (revision < (checkpoint?.revision ?? 0)) throw new Error('Source revision moved backward.');
        return {sales, more, inventory: more ? null : stock.all().map(product => ({...product})),
          checkpoint: {sourceId, seq: last?.seq ?? seq, lastSaleId: last?.id ?? checkpoint?.lastSaleId ?? null,
            revision: more ? (checkpoint?.revision ?? 0) : revision}};
      } finally { db.exec('COMMIT'); }
    }
  };
}

export async function mirrorPage(source, firestore) {
  const state = firestore.doc('clinchPos/main');
  return firestore.runTransaction(async tx => {
    const current = (await tx.get(state)).data();
    const batch = source.read(current);
    if (!batch.sales.length && current?.revision === batch.checkpoint.revision) return false;
    for (const sale of batch.sales) {
      const key = createHash('sha256').update(sale.operationId).digest('hex');
      tx.create(state.collection('receipts').doc(key), sale);
    }
    // During historical catch-up, publish stock only when the cursor reaches
    // the same SQLite snapshot. A lost cloud response can replay this page.
    if (batch.inventory) tx.set(state.collection('reports').doc('inventory'),
      {throughSequence: batch.checkpoint.seq, products: batch.inventory});
    tx.set(state, batch.checkpoint);
    return batch.more;
  });
}
