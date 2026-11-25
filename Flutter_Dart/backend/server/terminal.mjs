import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomUUID, createHash } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const validNumber = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validDate = s => typeof s === 'string' && s.length <= 32 && /^\d{4}-\d\d-\d\dT.*Z$/.test(s) && Number.isFinite(Date.parse(s));
const day = s => new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 10);
const skew = 5 * 60000;

export function createTerminal({db, now, transaction, fail, requireRole, audit, bump, sell}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_grants(id TEXT PRIMARY KEY, sessionHash TEXT NOT NULL, staff TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS terminal_grants_session ON terminal_grants(sessionHash);
    CREATE TABLE IF NOT EXISTS terminal_ledger(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, terminal TEXT NOT NULL, seq INTEGER NOT NULL, staff TEXT NOT NULL, shift TEXT NOT NULL, occurred TEXT NOT NULL, accepted TEXT NOT NULL, input TEXT NOT NULL, saleId TEXT, result TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS terminal_sequence ON terminal_ledger(terminal,seq);
    CREATE UNIQUE INDEX IF NOT EXISTS terminal_sale ON terminal_ledger(saleId) WHERE saleId IS NOT NULL;
    CREATE TABLE IF NOT EXISTS terminal_reviews(id TEXT PRIMARY KEY, code TEXT NOT NULL, error TEXT NOT NULL, receipt TEXT NOT NULL, createdAt TEXT NOT NULL, reviewedAt TEXT, reviewNote TEXT);
    CREATE INDEX IF NOT EXISTS terminal_open_reviews ON terminal_reviews(createdAt) WHERE reviewedAt IS NULL;
  `);
  const get = (q,...p) => db.prepare(q).get(...p);
  const run = (q,...p) => db.prepare(q).run(...p);
  let key = get("SELECT value FROM meta WHERE key='terminalSigningKey'")?.value;
  if (!key) {
    const pair = generateKeyPairSync('ed25519');
    run("INSERT OR IGNORE INTO meta VALUES ('terminalSigningKey',?)", pair.privateKey.export({format:'pem',type:'pkcs8'}));
    key = get("SELECT value FROM meta WHERE key='terminalSigningKey'").value;
  }
  const privateKey = createPrivateKey(key), verifyKey = createPublicKey(privateKey);
  const publicKey = verifyKey.export({format:'jwk'}).x;
  const stamp = () => new Date(now()).toISOString();

  function decodeGrant(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,1800}\.[A-Za-z0-9_-]{86}$/.test(token))
      fail(403,'INVALID_GRANT','The terminal authorization is invalid.');
    const [payload,sig] = token.split('.');
    if (!verify(null, Buffer.from(payload), verifyKey, Buffer.from(sig,'base64url')))
      fail(403,'INVALID_GRANT','The terminal authorization signature is invalid.');
    return JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  }

  function validateReceipt(r) {
    if (!r || ![r.operationId,r.terminalId,r.operatorId,r.shiftId].every(validId) ||
      !validNumber(r.sequence,1,Number.MAX_SAFE_INTEGER) || !validNumber(r.catalogVersion,1,Number.MAX_SAFE_INTEGER) ||
      !validDate(r.occurredAt) || r.method !== 'cash' || !validNumber(r.tendered,0,100000000) ||
      !Array.isArray(r.items) || r.items.length > 30 || (!r.items.length && !r.bookingId))
      fail(400,'INVALID_RECEIPT','The offline receipt is incomplete.');
    const seen = new Set();
    let total = 0;
    for (const item of r.items) {
      if (!validId(item?.productId) || !validNumber(item.quantity,1,100) || !validNumber(item.unitPrice,0,100000000) || seen.has(item.productId))
        fail(400,'INVALID_RECEIPT','Invalid quoted product line.');
      seen.add(item.productId);
      total += item.unitPrice * item.quantity;
    }
    if (r.bookingId) {
      if (!validId(r.bookingId) || !validNumber(r.bookingVersion,1,2147483647) || !validNumber(r.bookingTotal,0,100000000))
        fail(400,'INVALID_RECEIPT','Invalid quoted booking.');
      total += r.bookingTotal;
    }
    if (r.tendered < total) fail(400,'INVALID_RECEIPT','Recorded cash is below the quoted total.');
  }
  function addReview(id, code, message, r, actor) {
    const created = run('INSERT OR IGNORE INTO terminal_reviews VALUES(?,?,?,?,?,NULL,NULL)',id,code,message,JSON.stringify(r),stamp());
    if (created.changes) { audit(actor,'terminal.review',id + ': ' + message); bump(); }
  }
  function reconcile(r, grant, staff, grantRow, received) {
    if (!staff?.active || !['employee','owner'].includes(staff.role) || grantRow.revoked)
      return ['OPERATOR_REVOKED','Authorization was revoked. Verify the original cashier and cash received.'];
    const at = Date.parse(r.occurredAt);
    if (at < Date.parse(grant.issuedAt) - skew || at > Date.parse(grant.expiresAt) || at > Date.parse(received) + skew)
      return ['SHIFT_CLOCK','The terminal time falls outside the verified shift.'];
    if (get('SELECT id FROM terminal_ledger WHERE terminal=? AND seq=? LIMIT 1',r.terminalId,r.sequence))
      return ['SEQUENCE_CONFLICT','Another receipt already uses this terminal sequence.'];
    const prev = get('SELECT occurred FROM terminal_ledger WHERE terminal=? AND seq<? AND saleId IS NOT NULL ORDER BY seq DESC LIMIT 1',r.terminalId,r.sequence);
    const next = get('SELECT occurred FROM terminal_ledger WHERE terminal=? AND seq>? AND saleId IS NOT NULL ORDER BY seq LIMIT 1',r.terminalId,r.sequence);
    if ((prev && Date.parse(prev.occurred) > at+skew) || (next && Date.parse(next.occurred) < at-skew))
      return ['SHIFT_CLOCK','The device clock disagrees with the order of terminal receipts.'];
    for (const p of r.items) {
      const live = get('SELECT price FROM products WHERE id=?',p.productId);
      if (!live || live.price !== p.unitPrice) return ['PRICE_CHANGED','The current catalog differs from the recorded price. Verify the cash collected.'];
    }
    if (r.bookingId && get('SELECT total FROM bookings WHERE id=?',r.bookingId)?.total !== r.bookingTotal)
      return ['PRICE_CHANGED','The booking amount differs from the recorded quote.'];
    return null;
  }
  return {
    key(user, publicOrigin) { requireRole(user,'owner'); return {publicKey,publicOrigin}; },
    claims:decodeGrant,
    grant(session, sessionHash, terminalId, publicOrigin,authTime) {
      requireRole(session.user,'employee','owner');
      if (!validId(terminalId)) fail(400,'VALIDATION','A terminal identifier is required.');
      const grantId = randomUUID();
      const claims = {v:1,grantId,terminalId,userId:session.user.id,role:session.user.role,issuedAt:stamp(),expiresAt:session.expiresAt,publicOrigin};
      if(authTime)claims.authTime=authTime;
      const raw = Buffer.from(JSON.stringify(claims)).toString('base64url');
      run('INSERT INTO terminal_grants VALUES(?,?,?,?,0)',grantId,sessionHash,session.user.id,Date.parse(session.expiresAt));
      const lastSequence = get('SELECT COALESCE(MAX(seq),0) AS seq FROM terminal_ledger WHERE terminal=?',terminalId).seq;
      return {grant:raw+'.'+sign(null,Buffer.from(raw),privateKey).toString('base64url'),publicKey,expiresAt:session.expiresAt,lastSequence};
    },
    revokeSession(hash) { run('UPDATE terminal_grants SET revoked=1 WHERE sessionHash=?',hash); },
    revokeStaff(id) { run('UPDATE terminal_grants SET revoked=1 WHERE staff=?',id); },
    submit(user, input, publicOrigin, identityActive=true) {
      requireRole(user,'employee','owner');
      const grant = decodeGrant(input?.grant), r = input.receipt;
      validateReceipt(r);
      const grantRow = get('SELECT * FROM terminal_grants WHERE id=?',grant.grantId);
      if (!grantRow || grantRow.staff !== r.operatorId || grant.publicOrigin !== publicOrigin || grant.userId !== r.operatorId ||
          grant.terminalId !== r.terminalId || (user.role !== 'owner' && user.id !== r.operatorId))
        fail(403,'FORBIDDEN','The terminal authorization does not cover this cashier and terminal.');
      const fingerprint = digest(r), id = r.operationId;
      return transaction(() => {
        const prior = get('SELECT fingerprint,result FROM terminal_ledger WHERE id=?',id);
        if (prior) {
          if (prior.fingerprint === fingerprint) return JSON.parse(prior.result);
          const message = 'This receipt identifier also appears on a different cash record.';
          addReview('duplicate-'+fingerprint,'IDEMPOTENCY_CONFLICT',message,r,user);
          return {id,status:'conflict',code:'IDEMPOTENCY_CONFLICT',error:message};
        }
        const staff = get('SELECT id,name,active,role FROM users WHERE id=?',r.operatorId), accepted = stamp();
        let issue = identityActive?reconcile(r,grant,staff,grantRow,accepted):['OPERATOR_REVOKED','The original cashier authorization was revoked. Verify cash received.'], sale;
        if (!issue) {
          try {
            sale = sell(staff,{...r,terminalReceipt:true});
          } catch (error) {
            if (![400,403,404,409].includes(error.status)) throw error;
            issue = [error.code,error.message];
          }
        }
        const result = issue ? {id,status:'conflict',code:issue[0],error:issue[1]} :
          {id,status:'accepted',data:{...sale,operationId:id,operatorId:r.operatorId,shiftId:r.shiftId,occurredAt:r.occurredAt,acceptedAt:accepted}};
        run('INSERT INTO terminal_ledger VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,fingerprint,r.terminalId,r.sequence,r.operatorId,r.shiftId,r.occurredAt,accepted,JSON.stringify(r),sale?.id??null,JSON.stringify(result));
        if (issue) addReview('receipt-'+digest(id),...issue,r,user);
        else if (day(accepted) !== day(r.occurredAt)) {
          addReview('shift-'+digest(id),'LATE_SHIFT','Cash arrived after its Manila business date. Reconcile against its original shift.',r,user);
        }
        return result;
      });
    },
    reviews(user) {
      if (user.role !== 'owner') return [];
      return db.prepare('SELECT * FROM terminal_reviews WHERE reviewedAt IS NULL ORDER BY createdAt DESC').all()
        .map(row=>({...row,receipt:JSON.parse(row.receipt)}));
    },
    resolve(user,id,note) {
      requireRole(user,'owner');
      if (typeof note !== 'string' || note.trim().length < 3 || note.length > 500) fail(400,'VALIDATION','Enter a reconciliation note of 3–500 characters.');
      return transaction(()=>{
        if (!get('SELECT id FROM terminal_reviews WHERE id=?',id)) fail(404,'NOT_FOUND','Review not found.');
        const change = run('UPDATE terminal_reviews SET reviewedAt=?,reviewNote=? WHERE id=? AND reviewedAt IS NULL',stamp(),note.trim(),id);
        if (change.changes) { audit(user,'terminal.reconciled',id+': '+note.trim()); bump(); }
        return {ok:true};
      });
    }
  };
}
