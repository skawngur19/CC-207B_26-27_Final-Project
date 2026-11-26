// backend/server/website-mirror.mjs
// Copies settled cash sales from the Node API's SQLite database into the
// website's Firestore collections (sales, audit, products) using the website's field
// names, with money in centavos. Writes happen only through the Firebase Admin
// SDK on the server PC. Reuses the journal and checkpoint logic of
// firestore-mirror.mjs, which stays unchanged.
import { openMirrorSource } from './firestore-mirror.mjs';

const STATE_DOC = 'clinchPos/website';

export function openWebsiteSource(db) {
  const source = openMirrorSource(db);
  const nameOf = db.prepare('SELECT name FROM users WHERE id=?');
  const saved = db.prepare("SELECT value FROM meta WHERE key='websiteStockBaseline'").get();
  let stockBaseline;
  if (saved) {
    stockBaseline = Number(saved.value);
  } else {
    // Sales that exist at the first run are already counted in the stock that
    // Firestore holds today, so only later sales change Firestore stock.
    stockBaseline = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM firestore_journal').get().m);
    db.prepare("INSERT INTO meta VALUES('websiteStockBaseline',?)").run(String(stockBaseline));
  }
  return { ...source, stockBaseline, staffName: id => nameOf.get(id)?.name };
}

// Shape of a website sale: see the /sales route in the website's api.js.
function webSale(row, operatorUid) {
  const items = (row.items ?? []).map(line => {
    const quantity = line.quantity ?? line.qty;
    const unitPrice = line.unitPrice ?? line.price;
    const name = line.productName ?? line.name;
    if ((!line.productId && !line.bookingId) || !Number.isInteger(quantity) ||
        !Number.isInteger(unitPrice) || !name) {
      // Stop loudly rather than guess: a wrong guess would corrupt stock.
      throw new Error(`Sale ${row.id} has a line this mirror does not recognise: ${JSON.stringify(line)}`);
    }
    return {
      ...(line.productId ? { productId: line.productId } : {}),
      ...(line.bookingId ? { bookingId: line.bookingId } : {}),
      productName: name, name, unitPrice, price: unitPrice, quantity,
      total: line.total ?? unitPrice * quantity
    };
  });
  return {
    id: row.id,
    operationId: row.operationId,
    reference: row.reference,
    operatorId: operatorUid ?? row.staffId,
    total: row.total,
    tendered: row.tendered,
    change: row.change,
    method: row.method,
    source: 'windows',
    syncStatus: 'synced',
    createdAt: row.createdAt,
    items
  };
}

export async function mirrorToWebsite(source, firestore, options = {}) {
  const { dryRun = true, increment, operatorUid } = options;
  if (!dryRun && typeof increment !== 'function') {
    throw new Error('Live mode needs options.increment (FieldValue.increment).');
  }
  const state = firestore.doc(STATE_DOC);

  const plan = batch => {
    const sales = [], audits = [], stock = {};
    for (const row of batch.sales) {
      const sale = webSale(row, operatorUid);
      sales.push(sale);
      // Same shape the website writes for its own sales, so the owner's
      // Activity log shows sales made in the Windows app too.
      audits.push({ id: `sale-${sale.id}`, data: {
        userId: sale.operatorId,
        actor: source.staffName?.(row.staffId) ?? 'Windows app',
        action: 'sale.create',
        detail: `${sale.reference}: ${sale.total} centavos`,
        createdAt: sale.createdAt
      } });
      if (row.seq <= source.stockBaseline) continue;
      for (const line of sale.items) {
        if (line.productId) stock[line.productId] = (stock[line.productId] ?? 0) + line.quantity;
      }
    }
    return { sales, audits, stock };
  };

  if (dryRun) {
    const batch = source.read((await state.get()).data());
    const { sales, stock } = plan(batch);
    const missing = [];
    for (const id of Object.keys(stock)) {
      if (!(await firestore.doc(`products/${id}`).get()).exists) missing.push(id);
    }
    return { more: false, sales: sales.length, stock, missing, preview: sales[0] };
  }

  return firestore.runTransaction(async tx => {
    const batch = source.read((await tx.get(state)).data());
    if (!batch.sales.length) return { more: false, sales: 0, stock: {} };
    const { sales, audits, stock } = plan(batch);
    // create() fails if the sale already exists, and update() fails if a
    // product is missing, so a mismatch stops the whole page instead of
    // writing half of it. Never use set(..., {merge:true}) on products: a
    // product without a category breaks the website's product sort.
    for (const sale of sales) tx.create(firestore.doc(`sales/${sale.id}`), sale);
    for (const a of audits) tx.create(firestore.doc(`audit/${a.id}`), a.data);
    for (const [id, qty] of Object.entries(stock)) {
      tx.update(firestore.doc(`products/${id}`), { stock: increment(-qty) });
    }
    tx.set(state, batch.checkpoint);
    return { more: batch.more, sales: sales.length, stock };
  });
}