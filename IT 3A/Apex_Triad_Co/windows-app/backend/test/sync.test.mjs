import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../server/service.mjs';
import { openProductSource, mirrorProductsToWebsite } from '../server/product-sync.mjs';
import { importWebsiteSales, syncWebsiteStockToApp } from '../server/website-sales-sync.mjs';

function fakeFirestore({ sales = [], products = [], websiteSequence = 0 } = {}) {
  const productDocs = new Map(products.map(product => [product.id, { ...product.data }]));
  return {
    productDocs,
    collection(name) {
      if (name === 'products') {
        return { collectionName: name, get: async () => ({ docs: [...productDocs].map(([id, data]) => ({
          id, data: () => data
        })) }) };
      }
      const makeQuery = (cursor, size) => ({
        orderBy() { return this; },
        limit(value) { return makeQuery(cursor, value); },
        startAfter(createdAt, id) { return makeQuery({ createdAt, id }, size); },
        async get() {
          const ordered = [...sales].sort((a, b) =>
            a.data.createdAt.localeCompare(b.data.createdAt) || a.id.localeCompare(b.id));
          const after = cursor ? ordered.filter(sale =>
            sale.data.createdAt > cursor.createdAt ||
            (sale.data.createdAt === cursor.createdAt && sale.id > cursor.id)) : ordered;
          return { docs: after.slice(0, size).map(sale => ({
            id: sale.id, data: () => sale.data, get: key => sale.data[key]
          })) };
        }
      });
      return makeQuery(null, 100);
    },
    doc(path) {
      const id = path.split('/').pop();
      return { id, path };
    },
    async runTransaction(work) {
      return work({
        get: async ref => {
          if (ref.collectionName === 'products') {
            return { docs: [...productDocs].map(([id, data]) => ({ id, data: () => data })) };
          }
          if (ref.path === 'clinchPos/website') {
            return { data: () => ({ seq: websiteSequence }) };
          }
          return {
            exists: productDocs.has(ref.id),
            data: () => productDocs.get(ref.id)
          };
        },
        create: (ref, data) => productDocs.set(ref.id, { ...data }),
        update: (ref, data) => productDocs.set(ref.id, {
          ...productDocs.get(ref.id), ...data
        })
      });
    }
  };
}

test('app product journal mirrors creates and only explicitly edited fields', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE product_change_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,productId TEXT,data TEXT);
    INSERT INTO product_change_journal(productId,data)
    VALUES('p1','{"id":"p1","name":"Tea","category":"Drinks","price":150,"stock":8}'),
          ('p1','{"price":175}');`);
  const source = openProductSource(db);
  const firestore = fakeFirestore();
  const result = await mirrorProductsToWebsite(source, firestore, { dryRun: false });
  assert.equal(result.changes, 2);
  assert.deepEqual(firestore.productDocs.get('p1'), {
    id: 'p1', name: 'Tea', category: 'Drinks', price: 175, stock: 8
  });
  assert.equal(source.read().changes.length, 0);
  db.close();
});

test('product create and update operations record only intentional fields', async () => {
  const service = await createService({
    dbPath: ':memory:',
    ownerEmail: 'owner@example.test',
    ownerPassword: 'a-valid-test-password'
  });
  const owner = { id: 'owner', name: 'Owner', role: 'owner' };
  const product = service.createProduct(owner, {
    operationId: 'product-create-operation',
    name: 'Tea', category: 'Drinks', price: 150, stock: 8
  });
  service.updateProduct(owner, product.id, {
    name: 'Tea', category: 'Drinks', price: 175, stock: 8, version: product.version
  });
  const changes = service.db.prepare(
    'SELECT data FROM product_change_journal ORDER BY seq').all().map(row => JSON.parse(row.data));
  assert.deepEqual(changes[0], {
    id: product.id, name: 'Tea', category: 'Drinks', price: 150, stock: 8
  });
  assert.deepEqual(changes[1], { price: 175 });
  service.close();
});

test('website sales are imported once and website stock replaces stale app counts', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('revision','1');
    INSERT INTO meta VALUES('websiteStockBaseline','0');
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT);
    INSERT INTO users VALUES('owner','owner');
    CREATE TABLE products(id TEXT PRIMARY KEY,stock INTEGER,version INTEGER);
    INSERT INTO products VALUES('p1',9,1);
    CREATE TABLE sales(id TEXT PRIMARY KEY,reference TEXT UNIQUE,total INTEGER,tendered INTEGER,change INTEGER,method TEXT,createdAt TEXT,items TEXT,staffId TEXT);
    CREATE TABLE firestore_journal(seq INTEGER PRIMARY KEY,operationId TEXT,saleId TEXT);
    CREATE TABLE product_change_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,productId TEXT,data TEXT);
    CREATE TABLE audit(id TEXT PRIMARY KEY,userId TEXT,actor TEXT,action TEXT,detail TEXT,createdAt TEXT);`);
  const sale = {
    source: 'web', method: 'cash', reference: 'TX-WEB1', total: 300,
    tendered: 500, change: 200, createdAt: '2026-11-25T10:00:00.000Z',
    items: [{ productId: 'p1', productName: 'Tea', unitPrice: 150, quantity: 2, total: 300 }]
  };
  const firestore = fakeFirestore({
    sales: [{ id: 'web-sale-1', data: sale }],
    products: [{ id: 'p1', data: { stock: 7 } }]
  });
  const imported = await importWebsiteSales(db, firestore, {
    dryRun: false, documentId: '__name__'
  });
  assert.equal(imported.sales, 1);
  assert.equal((await importWebsiteSales(db, firestore, {
    dryRun: false, documentId: '__name__'
  })).sales, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
  db.prepare('INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?)').run(
    'local-sale', 'TX-LOCAL', 150, 200, 50, 'cash', '2026-11-25T10:01:00.000Z',
    JSON.stringify([{ productId: 'p1', quantity: 1 }]), 'owner');
  db.prepare('INSERT INTO firestore_journal VALUES(1,?,?)').run('local-operation', 'local-sale');
  assert.deepEqual((await syncWebsiteStockToApp(db, firestore, { dryRun: false })).updated, [
    { id: 'p1', stock: 6 }
  ]);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get('p1').stock, 6);
  db.prepare('UPDATE products SET stock=4 WHERE id=?').run('p1');
  db.prepare('INSERT INTO product_change_journal(productId,data) VALUES(?,?)')
    .run('p1', '{"stock":4}');
  assert.deepEqual((await syncWebsiteStockToApp(db, firestore, { dryRun: false })).updated, []);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get('p1').stock, 4);
  db.close();
});
