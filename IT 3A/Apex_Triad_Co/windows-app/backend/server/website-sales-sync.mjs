function validMoney(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateSale(id, sale) {
  if (typeof id !== 'string' || !id || sale?.source !== 'web' ||
      sale.method !== 'cash' || typeof sale.reference !== 'string' ||
      typeof sale.createdAt !== 'string' || !Array.isArray(sale.items) ||
      !validMoney(sale.total) || !validMoney(sale.tendered) ||
      !validMoney(sale.change) || sale.tendered < sale.total ||
      sale.change !== sale.tendered - sale.total) {
    throw new Error(`Website sale ${id} has an invalid or unsupported shape.`);
  }
  for (const item of sale.items) {
    if (!item || typeof item !== 'object' ||
        (!item.productId && !item.bookingId) ||
        typeof (item.productName ?? item.name) !== 'string' ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
        !validMoney(item.unitPrice ?? item.price) ||
        !validMoney(item.total ?? (item.unitPrice ?? item.price) * item.quantity)) {
      throw new Error(`Website sale ${id} has an invalid line item.`);
    }
  }
}

export async function importWebsiteSales(db, firestore, {
  dryRun = true, documentId = '__name__', limit = 100
} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS website_sales(
    saleId TEXT PRIMARY KEY NOT NULL, createdAt TEXT NOT NULL, reference TEXT NOT NULL)`);
  const saved = key => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  const cursorCreatedAt = saved('websiteSalesCursorCreatedAt');
  const cursorId = saved('websiteSalesCursorId');
  let query = firestore.collection('sales')
    .orderBy('createdAt').orderBy(documentId).limit(limit);
  if (cursorCreatedAt && cursorId) query = query.startAfter(cursorCreatedAt, cursorId);
  const docs = (await query.get()).docs;
  const websiteSales = docs.filter(doc => doc.data().source === 'web');
  if (dryRun) {
    return {
      sales: websiteSales.length,
      more: docs.length === limit,
      preview: websiteSales[0] ? { id: websiteSales[0].id, ...websiteSales[0].data() } : null
    };
  }
  if (!docs.length) return { sales: 0, more: false };

  const ownerId = db.prepare("SELECT id FROM users WHERE role='owner'").get()?.id;
  if (!ownerId) throw new Error('Cannot import website sales without an app owner account.');
  const insertSale = db.prepare(
    'INSERT INTO sales(id,reference,total,tendered,change,method,createdAt,items,staffId) VALUES(?,?,?,?,?,?,?,?,?)');
  const insertSource = db.prepare(
    'INSERT INTO website_sales(saleId,createdAt,reference) VALUES(?,?,?)');
  const insertAudit = db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)');
  const known = db.prepare('SELECT 1 AS found FROM website_sales WHERE saleId=?');
  const existingSale = db.prepare('SELECT 1 AS found FROM sales WHERE id=? OR reference=?');
  const bump = db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
  const setMeta = db.prepare(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  let imported = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const doc of websiteSales) {
      const sale = doc.data();
      validateSale(doc.id, sale);
      if (known.get(doc.id)) continue;
      if (existingSale.get(doc.id, sale.reference)) {
        throw new Error(`Website sale ${doc.id} conflicts with an existing app sale.`);
      }
      insertSale.run(doc.id, sale.reference, sale.total, sale.tendered, sale.change,
        sale.method, sale.createdAt, JSON.stringify(sale.items), ownerId);
      insertSource.run(doc.id, sale.createdAt, sale.reference);
      insertAudit.run(
        `website-sale-${doc.id}`, ownerId, 'Website', 'sale.create',
        `${sale.reference}: ${sale.total} centavos (website)`, sale.createdAt);
      imported++;
    }
    if (imported) bump.run();
    const last = docs[docs.length - 1];
    setMeta.run('websiteSalesCursorCreatedAt', last.get('createdAt'));
    setMeta.run('websiteSalesCursorId', last.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { sales: imported, more: docs.length === limit };
}

export async function syncWebsiteStockToApp(db, firestore, { dryRun = true } = {}) {
  const stateRef = firestore.doc('clinchPos/website');
  const productCollection = firestore.collection('products');
  const inventory = await firestore.runTransaction(async tx => {
    const state = await tx.get(stateRef);
    const products = await tx.get(productCollection);
    return {
      sequence: Number(state.data()?.seq ?? 0),
      products: products.docs.map(doc => {
        const data = doc.data();
        if (!Number.isSafeInteger(data.stock) || data.stock < 0) {
          throw new Error(`Website product ${doc.id} has an invalid stock count.`);
        }
        return { id: doc.id, stock: data.stock };
      })
    };
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    const baseline = Number(db.prepare(
      "SELECT value FROM meta WHERE key='websiteStockBaseline'").get()?.value ?? 0);
    const afterSequence = Math.max(inventory.sequence, baseline);
    const pending = db.prepare(`SELECT s.items FROM firestore_journal j
      JOIN sales s ON s.id=j.saleId WHERE j.seq>? ORDER BY j.seq`).all(afterSequence);
    const unsynced = new Map();
    for (const row of pending) {
      for (const item of JSON.parse(row.items)) {
        if (!item.productId) continue;
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
          throw new Error(`App sale contains an invalid quantity for product ${item.productId}.`);
        }
        unsynced.set(item.productId,
          (unsynced.get(item.productId) ?? 0) + item.quantity);
      }
    }
    const productCursor = Number(db.prepare(
      "SELECT value FROM meta WHERE key='productMirrorSeq'").get()?.value ?? 0);
    const pendingProductStock = new Set(db.prepare(
      'SELECT productId,data FROM product_change_journal WHERE seq>?').all(productCursor)
      .filter(row => Object.hasOwn(JSON.parse(row.data), 'stock'))
      .map(row => row.productId));
    const get = db.prepare('SELECT stock FROM products WHERE id=?');
    const changes = [], missing = [];
    for (const product of inventory.products) {
      const local = get.get(product.id);
      if (!local) {
        missing.push(product.id);
        continue;
      }
      if (pendingProductStock.has(product.id)) continue;
      const stock = product.stock - (unsynced.get(product.id) ?? 0);
      if (stock < 0) {
        throw new Error(`Website stock for ${product.id} is below app sales waiting to sync.`);
      }
      if (local.stock !== stock) changes.push({ ...product, stock });
    }
    if (dryRun || !changes.length) {
      db.exec('ROLLBACK');
      return { updated: changes, missing };
    }
    const update = db.prepare(
      'UPDATE products SET stock=?,version=version+1 WHERE id=? AND stock<>?');
    const bump = db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
    for (const product of changes) update.run(product.stock, product.id, product.stock);
    bump.run();
    db.exec('COMMIT');
    return { updated: changes, missing };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
