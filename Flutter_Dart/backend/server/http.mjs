import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './service.mjs';

const WEB_ROOT=fileURLToPath(new URL('../web/',import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const LOOPBACK=new Set(['127.0.0.1','localhost','::1']);
const MAX_BODY=65536;
const error=(status,code,message)=>{throw new ApiError(status,code,message);};
const sameSecret=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function body(req) {
  if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']??''))error(415,'CONTENT_TYPE','Use application/json.');
  if(Number(req.headers['content-length'])>MAX_BODY){req.resume();error(413,'BODY_TOO_LARGE','Request body is too large.');}
  return new Promise((resolveBody,reject)=>{
    let size=0,chunks=[],over=false;
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){over=true;chunks=[];}else if(!over)chunks.push(chunk);});
    req.on('end',()=>{
      if(over)return reject(new ApiError(413,'BODY_TOO_LARGE','Request body is too large.'));
      try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();resolveBody(value);}
      catch{return reject(new ApiError(400,'INVALID_JSON','A valid JSON object is required.'));}
    });
    req.on('error',reject);
    req.on('aborted',()=>reject(new ApiError(400,'ABORTED','Request was interrupted.')));
  });
}
function cookie(req,name) {
  const entries=(req.headers.cookie??'').split(';').map(p=>p.trim().split('='));
  return entries.find(([key])=>key===name)?.[1];
}

export function createHttpServer({service,host='127.0.0.1',webRoot=WEB_ROOT,publicOrigin,upstreamHost,relaySecret}={}) {
  if(!LOOPBACK.has(host)&&!publicOrigin)throw new Error('Configure a trusted HTTPS relay before binding outside loopback.');
  if(publicOrigin && (new URL(publicOrigin).protocol!=='https:' || new URL(publicOrigin).origin!==publicOrigin))
    throw new Error('Hosted mode requires a canonical HTTPS origin and real authentication.');
  if(publicOrigin && (!relaySecret || relaySecret.length<32))throw new Error('Hosted mode requires a relay secret of at least 32 characters.');
  const cookieName=publicOrigin?'__session':'clinch_session';
  const cookieFlags='Path=/; HttpOnly; SameSite=Strict'+(publicOrigin?'; Secure':'');
  const limits=new Map();
  const allowAttempt=(key,max,windowMs)=>{
    const time=Date.now();let item=limits.get(key);
    if(!item||time>=item.until)item={count:0,until:time+windowMs};
    item.count++;limits.set(key,item);
    if(limits.size>2000){for(const [k,v]of limits)if(v.until<=time)limits.delete(k);if(limits.size>2000)limits.delete(limits.keys().next().value);}
    if(item.count>max)error(429,'RATE_LIMIT','Too many attempts. Please try again later.');
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://127.0.0.1:8765; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
    try{
      const port=server.address()?.port;
      const allowed=LOOPBACK.has(host)?[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`]:[`${host}:${port}`];
      if(publicOrigin){allowed.push(new URL(publicOrigin).host);if(upstreamHost)allowed.push(upstreamHost);}
      if(!allowed.includes(req.headers.host))error(403,'HOST_REJECTED','Request host is not allowed.');
      if(publicOrigin&&!sameSecret(req.headers['x-clinch-relay'],relaySecret))error(403,'RELAY_REJECTED','A trusted hosting relay is required.');
      const origin=publicOrigin??`http://${req.headers.host}`;
      if(req.headers.origin&&req.headers.origin!==origin)error(403,'ORIGIN_REJECTED','Cross-origin requests are not allowed.');
      const url=new URL(req.url,origin);
      if(url.pathname.startsWith('/api/')){
        res.setHeader('Cache-Control','no-store');
        allowAttempt(`request:${req.socket.remoteAddress}`,600,60000);
        if(!['GET','POST'].includes(req.method))error(405,'METHOD_NOT_ALLOWED','This method is not supported.');
        const mutation=req.method==='POST';
        let data=mutation?await body(req):null;
        if(url.pathname==='/api/login'&&mutation){
          allowAttempt(`login:${req.socket.remoteAddress}`,25,15*60000);
          if(data.client!=='native'&&req.headers.origin!==origin)error(403,'ORIGIN_REJECTED','A same-origin request is required.');
          const result=await service.login(data);
          if(data.client==='native')return json(200,result);
          res.setHeader('Set-Cookie',`${cookieName}=${result.token}; ${cookieFlags}; Max-Age=28800`);
          const {token,...session}=result;return json(200,session);
        }
        if(url.pathname==='/api/register'&&mutation){
          if(req.headers.origin!==origin)error(403,'ORIGIN_REJECTED','A same-origin request is required.');
          allowAttempt(`register:${req.socket.remoteAddress}`,8,60*60000);
          return json(201,await service.register(data));
        }
        const auth=req.headers.authorization;
        const client=auth?'native':'browser';
        if(auth&&!/^Bearer [A-Za-z0-9_-]{40,100}$/.test(auth))error(401,'UNAUTHENTICATED','A valid bearer session is required.');
        const token=auth?auth.slice(7):cookie(req,cookieName);
        const session=await service.verifyIdentity(token,client);
        if(mutation&&client==='browser'){
          if(req.headers.origin!==origin)error(403,'ORIGIN_REJECTED','A same-origin request is required.');
          if(!sameSecret(req.headers['x-csrf-token'],session.csrf))error(403,'CSRF_REJECTED','The request security token is missing or invalid. Refresh and try again.');
        }
        const user=session.user,path=url.pathname;
        if(path==='/api/session'&&!mutation)return json(200,session);
        if(path==='/api/snapshot'&&!mutation)return json(200,service.snapshot(user));
        if(path==='/api/availability'&&!mutation)return json(200,service.availability(user,{date:url.searchParams.get('date'),startHour:Number(url.searchParams.get('startHour')),endHour:Number(url.searchParams.get('endHour'))}));
        if(path==='/api/logout'&&mutation){const result=service.logout(token);res.setHeader('Set-Cookie',`${cookieName}=; ${cookieFlags}; Max-Age=0`);return json(200,result);}
        if(path==='/api/terminal/key'&&!mutation)return json(200,service.terminal.key(user,origin));
        if(path==='/api/terminal/grant'&&!mutation)return json(200,service.grant(session,token,url.searchParams.get('terminalId'),origin));
        if(path==='/api/terminal/receipts'&&mutation)return json(200,await service.submitTerminal(user,data,origin));
        const reviewMatch=/^\/api\/terminal\/reviews\/([A-Za-z0-9_.:-]+)$/.exec(path);
        if(reviewMatch&&mutation)return json(200,service.terminal.resolve(user,reviewMatch[1],data.note));
        if(path==='/api/bookings'&&mutation)return json(201,service.book(user,data));
        const bookingMatch=/^\/api\/bookings\/([A-Za-z0-9_-]+)\/status$/.exec(path);
        if(bookingMatch&&mutation)return json(200,service.changeBookingStatus(user,bookingMatch[1],data));
        if(path==='/api/sales'&&mutation)return json(201,service.sell(user,data));
        if(path==='/api/products'&&mutation)return json(201,service.createProduct(user,data));
        const productMatch=/^\/api\/products\/([A-Za-z0-9_-]+)$/.exec(path);
        if(productMatch&&mutation)return json(200,service.updateProduct(user,productMatch[1],data));
        if(path==='/api/employees'&&mutation)return json(201,await service.createEmployee(user,data));
        const employeeMatch=/^\/api\/employees\/([A-Za-z0-9_-]+)\/status$/.exec(path);
        if(employeeMatch&&mutation)return json(200,service.setEmployeeStatus(user,employeeMatch[1],data));
        if(path==='/api/applications'&&mutation)return json(201,service.apply(user,data));
        if(path==='/api/jobs'&&mutation)return json(201,service.createJob(user,data));
        if(path==='/api/sync'&&mutation)return json(200,service.sync(user,data));
        error(404,'NOT_FOUND','API route was not found.');
      }
      if(!['GET','HEAD'].includes(req.method))error(405,'METHOD_NOT_ALLOWED','This method is not supported.');
      let path;
      try{path=decodeURIComponent(url.pathname);}catch{error(404,'NOT_FOUND','Page was not found.');}
      if(path==='/' )path='/index.html';
      if(path.includes('\\')||path.split('/').some(p=>p.startsWith('.'))||!MIME[extname(path)])error(404,'NOT_FOUND','Page was not found.');
      const root=resolve(webRoot),file=resolve(root,'.'+path);
      if(!file.startsWith(root+sep))error(404,'NOT_FOUND','Page was not found.');
      try{
        const real=await realpath(file);if(!real.startsWith(root+sep))error(404,'NOT_FOUND','Page was not found.');
        const content=await readFile(real);res.setHeader('Content-Type',MIME[extname(path)]);res.setHeader('Cache-Control','no-cache');res.statusCode=200;res.end(req.method==='HEAD'?undefined:content);
      }catch(e){if(e instanceof ApiError)throw e;error(404,'NOT_FOUND','Page was not found.');}
    }catch(e){
      if(res.headersSent){res.end();return;}
      if(e instanceof ApiError)return json(e.status,{error:e.message,code:e.code});
      console.error('Request failed:',e.message);
      json(500,{error:'An internal error occurred.',code:'INTERNAL_ERROR'});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=50;server.keepAliveTimeout=3000;
  return server;
}
