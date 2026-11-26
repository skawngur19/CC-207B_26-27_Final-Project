import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTerminal } from './terminal.mjs';

const derive = promisify(scrypt);
const ROLES = ['customer','employee','owner'];
const SESSION_MS = 8 * 60 * 60 * 1000;
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const fail=(status,code,message)=>{throw new ApiError(status,code,message);};
const requireRole=(user,...roles)=>{if(!user || !roles.includes(user.role)) fail(403,'FORBIDDEN','This action is not available to this role.');};
const object=value=>{if(!value || typeof value!=='object' || Array.isArray(value)) fail(400,'VALIDATION','A JSON object is required.');return value;};
const text=(value,label,max=160,min=1)=>{if(typeof value!=='string' || value.trim().length<min || value.trim().length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(400,'VALIDATION',`${label} must contain ${min}–${max} characters.`); return value.trim();};
const int=(value,label,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max) fail(400,'VALIDATION',`${label} is outside its allowed range.`);return value;};
const email=value=>{const v=text(value,'Email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))fail(400,'VALIDATION','Enter a valid email address.');return v;};
const password=value=>{if(typeof value!=='string'||value.length<12||value.length>128)fail(400,'VALIDATION','Password must contain 12–128 characters.');return value;};
const opId=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))fail(400,'VALIDATION','A valid unique operation ID is required.');return value;};
function catalogFields(input) {
  object(input);
  return [text(input.name,'Product name',100),text(input.category,'Category',60),
    int(input.price,'Unit price',1,100000000),int(input.stock,'Stock',0,1000000)];
}
const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role});
const tokenHash=token=>createHash('sha256').update(token).digest('hex');
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
async function hashPassword(value) {
  const salt=randomBytes(16).toString('hex');
  const hash=await derive(value,salt,64,{N:16384,r:8,p:5,maxmem:64*1024*1024});
  return `scrypt$16384$8$5$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(value,encoded) {
  let salt,hex,N=16384,r=8,p=1;
  if(encoded.startsWith('scrypt$')){const parts=encoded.split('$');N=Number(parts[1]);r=Number(parts[2]);p=Number(parts[3]);salt=parts[4];hex=parts[5];}
  else [salt,hex]=encoded.split(':'); // Existing local databases used the initial p=1 format.
  const hash=await derive(value,salt,64,{N,r,p,maxmem:64*1024*1024});
  const saved=Buffer.from(hex,'hex');
  return saved.length===hash.length&&timingSafeEqual(saved,hash);
}

export async function createService({dbPath='data/clinch.sqlite',ownerPassword,ownerEmail,identity=null,now=Date.now}={}) {
  if(dbPath!==':memory:') mkdirSync(dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);
  // Reject a training database before changing any of its tables or users.
  const hasMeta=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  const legacyMode=hasMeta && db.prepare("SELECT value FROM meta WHERE key='demo'").get();
  if(legacyMode && legacyMode.value!=='false'){
    db.close();throw new Error('This database cannot be used for live accounts. Choose the business database.');
  }
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE,role TEXT NOT NULL CHECK(role IN ('owner','employee','customer')),password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),createdAt TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS only_one_owner ON users(role) WHERE role='owner';
    CREATE TRIGGER IF NOT EXISTS protect_owner_delete BEFORE DELETE ON users WHEN OLD.role='owner' BEGIN SELECT RAISE(ABORT,'protected owner'); END;
    CREATE TRIGGER IF NOT EXISTS protect_owner_update BEFORE UPDATE ON users WHEN OLD.role='owner' AND (NEW.role!='owner' OR NEW.active!=1 OR NEW.id!=OLD.id) BEGIN SELECT RAISE(ABORT,'protected owner'); END;
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,client TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS federated_sessions(hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,authTime INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,capacity INTEGER NOT NULL,rate INTEGER NOT NULL CHECK(rate>=0));
    CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,resourceId TEXT NOT NULL REFERENCES resources(id),customerId TEXT REFERENCES users(id),customerName TEXT NOT NULL,date TEXT NOT NULL,startHour INTEGER NOT NULL,endHour INTEGER NOT NULL,total INTEGER NOT NULL CHECK(total>=0),status TEXT NOT NULL,paid INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS booking_overlap ON bookings(resourceId,date,startHour,endHour);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,price INTEGER NOT NULL CHECK(price>=0),stock INTEGER NOT NULL CHECK(stock>=0),version INTEGER NOT NULL DEFAULT 1);

    CREATE TABLE IF NOT EXISTS product_change_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,productId TEXT NOT NULL,data TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,total INTEGER NOT NULL CHECK(total>=0),tendered INTEGER NOT NULL,change INTEGER NOT NULL,method TEXT NOT NULL,createdAt TEXT NOT NULL,items TEXT NOT NULL,staffId TEXT NOT NULL REFERENCES users(id));
    CREATE TRIGGER IF NOT EXISTS sales_immutable_update BEFORE UPDATE ON sales BEGIN SELECT RAISE(ABORT,'sales are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sales_immutable_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT,'sales are immutable'); END;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL,description TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,jobId TEXT NOT NULL REFERENCES jobs(id),customerId TEXT NOT NULL REFERENCES users(id),customerName TEXT NOT NULL,message TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(jobId,customerId));
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,userId TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,userId TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,createdAt TEXT NOT NULL);
  `);
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const stamp=()=>new Date(now()).toISOString();
  const transaction=fn=>{
    const nested=db.isTransaction;
    db.exec(nested?'SAVEPOINT nested_sale':'BEGIN IMMEDIATE');
    try{const result=fn();db.exec(nested?'RELEASE nested_sale':'COMMIT');return result;}
    catch(error){db.exec(nested?'ROLLBACK TO nested_sale; RELEASE nested_sale':'ROLLBACK');throw error;}
  };
  const audit=(actor,action,detail)=>run('INSERT INTO audit VALUES(?,?,?,?,?,?)',randomUUID(),actor.id,actor.name,action,detail,stamp());

  const recordProductChange=(id,data)=>run('INSERT INTO product_change_journal(productId,data) VALUES(?,?)',id,JSON.stringify(data));

  const bump=()=>run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
  const provider=identity?'firebase':'local';
  const storedProvider=get("SELECT value FROM meta WHERE key='authProvider'")?.value;
  if((storedProvider && storedProvider!==provider) || (!storedProvider && legacyMode && identity)){
    db.close();throw new Error('Database authentication provider mismatch. Use a separate database or an explicit identity migration.');
  }
  if(!get("SELECT id FROM users WHERE role='owner'")) {
    let address;
    try {address=email(ownerEmail);}catch{db.close();throw new Error('First startup requires a valid CLINCH_OWNER_EMAIL.');}
    if(!identity && (typeof ownerPassword!=='string'||ownerPassword.length<12||ownerPassword.length>128)) {db.close();throw new Error('First startup requires CLINCH_OWNER_PASSWORD with 12–128 characters.');}
    const ownerHash=await hashPassword(identity?randomUUID():ownerPassword);
    transaction(()=>{
      run("INSERT OR IGNORE INTO meta VALUES('revision','1')");
      run('INSERT INTO users VALUES(?,?,?,?,?,1,?)','owner','Owner',address,'owner',ownerHash,stamp());
      for(let i=1;i<=12;i++){const id=`A${String(i).padStart(2,'0')}`;run('INSERT INTO resources VALUES(?,?,?,?,?)',id,`Seat ${id}`,'seat',1,5000);}
      for(const [id,name,capacity,rate]of[['narra','Narra',4,20000],['acacia','Acacia',6,30000],['molave','Molave',4,20000]])run('INSERT INTO resources VALUES(?,?,?,?,?)',id,`${name} Room`,'room',capacity,rate);
    });
  }
  run("INSERT OR IGNORE INTO meta VALUES('authProvider',?)",provider);
  if(!all('PRAGMA table_info(products)').some(column=>column.name==='version')){
    run('ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  // Correct the original reference capacities in existing local databases too.
  run("UPDATE resources SET capacity=4 WHERE id='narra'");
  run("UPDATE resources SET capacity=6 WHERE id='acacia'");
  const dummyHash=await hashPassword(randomBytes(32).toString('hex'));
  const mapBooking=b=>({...b,paid:!!b.paid});
  const getBooking=id=>{const b=get('SELECT * FROM bookings WHERE id=?',id);if(!b)fail(404,'NOT_FOUND','Booking was not found.');return mapBooking(b);};
  const receipt=(actor,type,input,fn)=>{
    object(input);const id=opId(input.operationId);const {operationId,...payload}=input;
    const fingerprint=tokenHash(stable({type,payload}));
    return transaction(()=>{
      const prior=get('SELECT * FROM receipts WHERE id=?',id);
      if(prior){if(prior.userId!==actor.id||prior.fingerprint!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT','This operation ID has already been used for a different request.');return JSON.parse(prior.data);}
      const result=fn(payload);
      run('INSERT INTO receipts VALUES(?,?,?,?,?)',id,actor.id,fingerprint,JSON.stringify(result),stamp());bump();return result;
    });
  };
  const service={
    db,close:()=>db.close(),
    async login(input) {
      object(input);const role=text(input.role,'Role',20);
      if(!ROLES.includes(role))fail(400,'VALIDATION','Choose a valid account role.');
      const client=input.client??'browser';if(!['browser','native'].includes(client))fail(400,'VALIDATION','Invalid client.');
      if(client==='native'&&role!=='owner')fail(403,'FORBIDDEN','The continuity app is for Owner accounts only.');
      const loginEmail=email(input.email);
      if(typeof input.password!=='string'||input.password.length<1||input.password.length>128)fail(400,'VALIDATION','Enter your password.');
      const pass=input.password;
      const user=get('SELECT * FROM users WHERE email=?',loginEmail);
      const remote=identity?await identity.login(loginEmail,pass):null;
      const valid=identity?remote.uid===user?.id:await verifyPassword(pass,user?.password??dummyHash);
      if(!user||!user.active||user.role!==role||!valid)fail(401,'INVALID_CREDENTIALS','Email, password, or selected role is incorrect.');
      const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url'),expires=now()+SESSION_MS;
      run('DELETE FROM sessions WHERE expires<=?',now());
      transaction(()=>{
        run('INSERT INTO sessions VALUES(?,?,?,?,?)',tokenHash(token),user.id,csrf,client,expires);
        if(remote)run('INSERT INTO federated_sessions VALUES(?,?)',tokenHash(token),remote.authTime);
      });
      audit(user,'session.login',`${client} login`);
      return {user:publicUser(user),csrf,token,expiresAt:new Date(expires).toISOString()};
    },
    authenticate(token,client) {
      if(typeof token!=='string'||token.length>200)fail(401,'UNAUTHENTICATED','Please sign in.');
      const session=get('SELECT s.*,u.name,u.email,u.role,u.active FROM sessions s JOIN users u ON u.id=s.userId WHERE s.hash=?',tokenHash(token));
      if(!session||!session.active||session.expires<=now()||session.client!==client)fail(401,'UNAUTHENTICATED','Your session has expired. Please sign in.');
      return {user:{id:session.userId,name:session.name,email:session.email,role:session.role},csrf:session.csrf,expiresAt:new Date(session.expires).toISOString()};
    },
    async verifyIdentity(token,client){
      const session=service.authenticate(token,client);
      if(!identity)return session;
      const authTime=get('SELECT authTime FROM federated_sessions WHERE hash=?',tokenHash(token))?.authTime;
      if(!authTime || !await identity.active(session.user.id,authTime))fail(401,'UNAUTHENTICATED','Sign in again to verify this account.');
      return service.authenticate(token,client);
    },
    logout(token){const hash=tokenHash(token);transaction(()=>{service.terminal.revokeSession(hash);run('DELETE FROM sessions WHERE hash=?',hash);});return {ok:true};},
    async register(input) {
      object(input);const name=text(input.name,'Name',100),address=email(input.email),pass=password(input.password);
      const hashed=identity?dummyHash:await hashPassword(pass);
      if(get('SELECT id FROM users WHERE email=?',address))fail(409,'EMAIL_EXISTS','An account already uses that email.');
      const id=randomUUID();
      if(identity)await identity.create({id,email:address,name,password:pass});
      try{transaction(()=>{run('INSERT INTO users VALUES(?,?,?,?,?,1,?)',id,name,address,'customer',hashed,stamp());audit({id,name},'customer.register','Customer account created');bump();});}
      catch(e){if(identity)await identity.rollback(id);throw e;}
      return {ok:true};
    },
    snapshot(user) {
      requireRole(user,...ROLES);
      const isCustomer=user.role==='customer',isOwner=user.role==='owner';
      return {user,revision:Number(get("SELECT value FROM meta WHERE key='revision'").value),serverTime:stamp(),
        resources:all('SELECT * FROM resources ORDER BY type DESC,id'),
        bookings:(isCustomer?all('SELECT * FROM bookings WHERE customerId=? ORDER BY date,startHour',user.id):all('SELECT * FROM bookings ORDER BY date,startHour')).map(mapBooking),
        products:all('SELECT * FROM products ORDER BY category,name'),
        sales:isCustomer?[]:all('SELECT s.id,s.reference,s.total,s.tendered,s.change,s.method,s.createdAt,s.items,l.id AS operationId,l.shift AS shiftId,l.occurred AS occurredAt,l.accepted AS acceptedAt FROM sales s LEFT JOIN terminal_ledger l ON l.saleId=s.id ORDER BY s.createdAt DESC').map(s=>({...s,items:JSON.parse(s.items)})),
        terminalReviews:service.terminal.reviews(user),
        employees:isOwner?all("SELECT id,name,email,role,active,createdAt FROM users WHERE role='employee' ORDER BY name").map(e=>({...e,active:!!e.active})):[],
        jobs:all('SELECT * FROM jobs ORDER BY title').map(j=>({...j,open:!!j.open})),
        applications:(isCustomer?all('SELECT * FROM applications WHERE customerId=?',user.id):isOwner?all('SELECT * FROM applications ORDER BY createdAt DESC'):[]),
        audit:isOwner?all('SELECT * FROM audit ORDER BY createdAt DESC LIMIT 200'):[]};
    },
    availability(user,input) {
      requireRole(user,...ROLES);object(input);
      const date=text(input.date,'Date',10),start=int(input.startHour,'Start hour',8,21),end=int(input.endHour,'End hour',9,22);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||end<=start)fail(400,'VALIDATION','Choose a valid date and time range.');
      const occupied=all("SELECT resourceId,status FROM bookings WHERE date=? AND status IN ('confirmed','checked_in') AND startHour<? AND endHour>?",date,end,start);
      return {availability:all('SELECT id FROM resources ORDER BY id').map(resource=>({resourceId:resource.id,status:occupied.some(b=>b.resourceId===resource.id&&b.status==='checked_in')?'occupied':occupied.some(b=>b.resourceId===resource.id)?'reserved':'available'}))};
    },
    book(user,input) {
      requireRole(user,...ROLES);
      return receipt(user,'booking',input,payload=>{
        const resourceId=text(payload.resourceId,'Resource',40),date=text(payload.date,'Date',10);
        const resource=get('SELECT * FROM resources WHERE id=?',resourceId);if(!resource)fail(404,'NOT_FOUND','Choose an available resource.');
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)fail(400,'VALIDATION','Choose a valid date.');
        const start=int(payload.startHour,'Start hour',8,21),end=int(payload.endHour,'End hour',9,22);
        const starts=Date.parse(`${date}T${String(start).padStart(2,'0')}:00:00+08:00`);
        if(end<=start||starts<now()||starts>now()+180*86400000)fail(400,'VALIDATION','Choose a future booking of at least one hour within 180 days.');
        if(get("SELECT id FROM bookings WHERE resourceId=? AND date=? AND status IN ('confirmed','checked_in') AND startHour<? AND endHour>?",resourceId,date,end,start))fail(409,'BOOKING_CONFLICT','This space is already reserved during the selected time.');
        const id=randomUUID(),reference=`CL-${id.slice(0,8).toUpperCase()}`;
        const name=user.role==='customer'?user.name:(payload.customerName?text(payload.customerName,'Customer name',100):'Walk-in guest');
        run('INSERT INTO bookings VALUES(?,?,?,?,?,?,?,?,?,?,0,1)',id,reference,resourceId,user.role==='customer'?user.id:null,name,date,start,end,(end-start)*resource.rate,'confirmed');
        audit(user,'booking.create',reference);return getBooking(id);
      });
    },
    changeBookingStatus(user,id,input) {
      requireRole(user,...ROLES);object(input);const status=text(input.status,'Status',30),version=int(input.version,'Version',1,2147483647);
      return transaction(()=>{
        const b=getBooking(id);if(b.version!==version)fail(409,'STALE_VERSION','This booking changed. Refresh and review it.');
        if(user.role==='customer'){
          const starts=Date.parse(`${b.date}T${String(b.startHour).padStart(2,'0')}:00:00+08:00`);
          if(b.customerId!==user.id||status!=='cancelled'||b.status!=='confirmed'||starts<=now()||b.paid)fail(403,'FORBIDDEN','Only your future unpaid confirmed bookings can be cancelled.');
        }
        const allowed={confirmed:['checked_in','cancelled'],checked_in:['completed'],completed:[],cancelled:[]};
        if(!allowed[b.status]?.includes(status))fail(409,'INVALID_TRANSITION','This booking status change is not allowed.');
        if(status==='cancelled'&&b.paid)fail(409,'PAID_BOOKING','Paid bookings cannot be cancelled. Contact the owner.');
        if(status==='completed'&&!b.paid)fail(409,'UNPAID_BOOKING','Collect the booking payment before completing it.');
        run('UPDATE bookings SET status=?,version=version+1 WHERE id=?',status,id);audit(user,'booking.status',`${b.reference}: ${status}`);bump();return getBooking(id);
      });
    },
    sell(user,input) {
      requireRole(user,'employee','owner');
      return receipt(user,'sale',input,payload=>{
        if(payload.method!=='cash')fail(400,'VALIDATION','Only cash payments are supported.');
        if(!Array.isArray(payload.items)||payload.items.length>30)fail(400,'VALIDATION','Choose at most 30 product lines.');
        const seen=new Set(),items=[];let total=0;
        for(const line of payload.items){object(line);const id=text(line.productId,'Product',40),quantity=int(line.quantity,'Quantity',1,100);if(seen.has(id))fail(400,'VALIDATION','Each product may appear only once.');seen.add(id);
          const p=get('SELECT * FROM products WHERE id=?',id);if(!p)fail(404,'NOT_FOUND','Product was not found.');if(p.stock<quantity)fail(409,'OUT_OF_STOCK',`${p.name} does not have enough stock.`);
          items.push({productId:id,productName:p.name,unitPrice:p.price,name:p.name,price:p.price,quantity,total:p.price*quantity});total+=p.price*quantity;
        }
        let booking;
        if(payload.bookingId){booking=getBooking(text(payload.bookingId,'Booking',80));const version=int(payload.bookingVersion,'Booking version',1,2147483647);
          if(booking.version!==version)fail(409,'STALE_VERSION','This booking changed. Refresh and review before collecting payment.');
          if(booking.paid)fail(409,'ALREADY_PAID','This booking has already been paid.');
          if(booking.status==='cancelled'||booking.status==='completed')fail(409,'INVALID_BOOKING','This booking cannot be collected.');
          items.push({bookingId:booking.id,productName:`Booking ${booking.reference}`,unitPrice:booking.total,name:`Booking ${booking.reference}`,price:booking.total,quantity:1,total:booking.total});total+=booking.total;
        }
        if(!items.length)fail(400,'VALIDATION','Add a product or an unpaid booking.');
        const tendered=int(payload.tendered,'Cash tendered',0,100000000);
        if(tendered<total)fail(409,'INSUFFICIENT_CASH','Cash tendered is below the total.');
        for(const item of items)if(item.productId)run('UPDATE products SET stock=stock-?,version=version+1 WHERE id=?',item.quantity,item.productId);
        if(booking)run('UPDATE bookings SET paid=1,version=version+1 WHERE id=?',booking.id);
        const id=randomUUID(),sale={id,reference:`TX-${id.slice(0,8).toUpperCase()}`,total,tendered,change:tendered-total,method:'cash',createdAt:stamp(),items};
        run('INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?)',id,sale.reference,total,tendered,sale.change,'cash',sale.createdAt,JSON.stringify(items),user.id);
        audit(user,'sale.create',`${sale.reference}: ${total} centavos`);return sale;
      });
    },
    createProduct(user,input) {
      requireRole(user,'owner');
      return receipt(user,'product.create',input,payload=>{
        const id=randomUUID();

        const [name,category,price,stock]=catalogFields(payload);
        run('INSERT INTO products(id,name,category,price,stock) VALUES(?,?,?,?,?)',id,name,category,price,stock);
        recordProductChange(id,{id,name,category,price,stock});

        run('INSERT INTO products(id,name,category,price,stock) VALUES(?,?,?,?,?)',id,...catalogFields(payload));

        audit(user,'product.create',id);
        return get('SELECT * FROM products WHERE id=?',id);
      });
    },
    updateProduct(user,id,input) {
      requireRole(user,'owner');const fields=catalogFields(input),version=int(input.version,'Version',1,Number.MAX_SAFE_INTEGER);
      return transaction(()=>{

        const prior=get('SELECT id,name,category,price,stock FROM products WHERE id=?',id);
        if(!prior)fail(404,'NOT_FOUND','Product was not found.');
        const updated=run('UPDATE products SET name=?,category=?,price=?,stock=?,version=version+1 WHERE id=? AND version=?',...fields,id,version);
        if(!updated.changes)fail(409,'STALE_VERSION','Stock or price changed. Refresh before editing this product.');
        const data=Object.fromEntries(['name','category','price','stock']
          .flatMap((key,index)=>prior[key]===fields[index]?[]:[[key,fields[index]]]));
        if(Object.keys(data).length)recordProductChange(id,data);

        const prior=get('SELECT id FROM products WHERE id=?',id);
        if(!prior)fail(404,'NOT_FOUND','Product was not found.');
        const updated=run('UPDATE products SET name=?,category=?,price=?,stock=?,version=version+1 WHERE id=? AND version=?',...fields,id,version);
        if(!updated.changes)fail(409,'STALE_VERSION','Stock or price changed. Refresh before editing this product.');

        audit(user,'product.update',id);bump();
        return get('SELECT * FROM products WHERE id=?',id);
      });
    },
    async createEmployee(user,input) {
      requireRole(user,'owner');object(input);const name=text(input.name,'Name',100),address=email(input.email),pass=password(input.password),hashed=identity?dummyHash:await hashPassword(pass);
      if(get('SELECT id FROM users WHERE email=?',address))fail(409,'EMAIL_EXISTS','An account already uses that email.');
      const id=randomUUID();
      if(identity)await identity.create({id,email:address,name,password:pass});
      try{transaction(()=>{run('INSERT INTO users VALUES(?,?,?,?,?,1,?)',id,name,address,'employee',hashed,stamp());audit(user,'employee.create',address);bump();});}
      catch(e){if(identity)await identity.rollback(id);throw e;}return {ok:true};
    },
    setEmployeeStatus(user,id,input) {
      requireRole(user,'owner');object(input);if(typeof input.active!=='boolean')fail(400,'VALIDATION','Active must be true or false.');
      const target=get('SELECT * FROM users WHERE id=?',id);if(!target)fail(404,'NOT_FOUND','Employee was not found.');
      if(target.role!=='employee')fail(403,'FORBIDDEN','Only employee accounts may be enabled or disabled.');
      transaction(()=>{run('UPDATE users SET active=? WHERE id=?',Number(input.active),id);if(!input.active){service.terminal.revokeStaff(id);run('DELETE FROM sessions WHERE userId=?',id);}audit(user,'employee.status',`${target.email}: ${input.active?'active':'disabled'}`);bump();});return {ok:true};
    },
    apply(user,input) {
      requireRole(user,'customer');object(input);const jobId=text(input.jobId,'Opening',80),message=text(input.message,'Application',2000);
      if(!get('SELECT id FROM jobs WHERE id=? AND open=1',jobId))fail(404,'NOT_FOUND','This opening is not accepting applications.');
      if(get('SELECT id FROM applications WHERE jobId=? AND customerId=?',jobId,user.id))fail(409,'ALREADY_APPLIED','You have already applied for this opening.');
      transaction(()=>{run('INSERT INTO applications VALUES(?,?,?,?,?,?)',randomUUID(),jobId,user.id,user.name,message,stamp());audit(user,'application.create',jobId);bump();});return {ok:true};
    },
    createJob(user,input) {
      requireRole(user,'owner');object(input);const title=text(input.title,'Title',120),type=text(input.type,'Employment type',60),description=text(input.description,'Description',2000);
      transaction(()=>{run('INSERT INTO jobs VALUES(?,?,?,?,1)',randomUUID(),title,type,description);audit(user,'job.create',title);bump();});return {ok:true};
    },
    sync(user,input) {
      requireRole(user,'owner');object(input);if(!Array.isArray(input.operations)||input.operations.length>50)fail(400,'VALIDATION','A sync attempt accepts at most 50 operations.');
      const results=input.operations.map(op=>{
        let id=typeof op?.id==='string'?op.id:'';
        try{object(op);opId(id);object(op.payload);if(!['booking','sale'].includes(op.type))fail(400,'VALIDATION','Unknown operation type.');const payload={...op.payload,operationId:id};const data=op.type==='booking'?service.book(user,payload):service.sell(user,payload);return {id,status:'accepted',data};}
        catch(error){if(!(error instanceof ApiError))throw error;return {id,status:error.status===409?'conflict':'rejected',error:error.message,code:error.code};}
      });
      return {results,revision:Number(get("SELECT value FROM meta WHERE key='revision'").value)};
    }
  };
  service.terminal=createTerminal({db,now,transaction,fail,requireRole,audit,bump,sell:(staff,r)=>service.sell(staff,r)});
  service.grant=(session,token,id,origin)=>{
    const hash=tokenHash(token);
    const authTime=identity?get('SELECT authTime FROM federated_sessions WHERE hash=?',hash)?.authTime:null;
    return service.terminal.grant(session,hash,id,origin,authTime);
  };
  service.submitTerminal=async(user,input,origin)=>{
    const claims=service.terminal.claims(input?.grant);
    const active=!identity || (!!claims.authTime && await identity.active(claims.userId,claims.authTime));
    return service.terminal.submit(user,input,origin,active);
  };
  return service;
}
