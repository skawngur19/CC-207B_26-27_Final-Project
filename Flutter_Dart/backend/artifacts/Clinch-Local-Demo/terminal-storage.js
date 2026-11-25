(() => {
'use strict';
let opening;
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const open = indexedDB.open('clinch-terminal-v1', 2);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('settings')) open.result.createObjectStore('settings');
      const rows = open.result.objectStoreNames.contains('receipts')?open.transaction.objectStore('receipts'):
        open.result.createObjectStore('receipts', {keyPath:'id'});
      if (!rows.indexNames.contains('operator')) rows.createIndex('operator', 'operatorId');
      if (!rows.indexNames.contains('terminal')) rows.createIndex('terminal','receipt.terminalId');
    };
    open.onsuccess = () => {
      open.result.onversionchange = () => { open.result.close(); opening = null; };
      resolve(open.result);
    };
    open.onerror = () => { opening = null; reject(open.error); };
  });
  return opening;
}
const result = request => new Promise((resolve,reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function transaction(stores, mode, work) {
  const db = await database();
  const tx = db.transaction(stores, mode, mode === 'readwrite' ? {durability:'strict'} : undefined);
  const done = new Promise((resolve,reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('Terminal storage transaction was cancelled.'));
  });
  try {
    const value = await work(tx.objectStore('settings'), stores.includes('receipts') ? tx.objectStore('receipts') : null);
    await done;
    return value;
  } catch (error) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw error;
  }
}
const read = key => transaction(['settings'],'readonly', m => result(m.get(key)));
const write = (key,value) => transaction(['settings'],'readwrite', m => result(m.put(value,key)));
const list = who => transaction(['settings','receipts'],'readonly', (_,r) => result(r.index('operator').getAll(who)));
const locked = work => transaction(['settings','receipts'],'readwrite', (m,r) => work({
  get:k => result(m.get(k)), put:(k,v) => result(m.put(v,k)), del:k => result(m.delete(k)),
  rows:who => result(r.index('operator').getAll(who)), terminal:id => result(r.index('terminal').getAll(id)),
  all:()=>result(r.getAll()),row:id => result(r.get(id)),
  save:row => result(r.put(row)), remove:id => result(r.delete(id))
}));
globalThis.ClinchTerminalStorage = Object.freeze({read,write,list,locked});
})();
