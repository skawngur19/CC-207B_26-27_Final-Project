import http from 'node:http';
import https from 'node:https';

// The destination is fixed at startup. Client-supplied URL, Host and forwarded
// headers never select the upstream service, including on malformed requests.
export function createRelay({upstream,relaySecret,request=https.request}) {
  const base=new URL(upstream);
  if (base.protocol!=='https:' || base.origin!==upstream || relaySecret?.length<32 || !relaySecret)
    throw new Error('Set a canonical HTTPS API origin and a relay secret of at least 32 characters.');
  return http.createServer((req,res)=>{
    const fail=status=>{
      if(res.headersSent){res.destroy();return;}
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});
      res.end(JSON.stringify({code:'UPSTREAM_UNAVAILABLE',error:'The shared API is unavailable.'}));
    };
    if(!['GET','POST'].includes(req.method)||!req.url.startsWith('/api/')||/[\\\r\n#]/.test(req.url))return fail(404);
    const path=new URL(req.url,base);
    if(path.origin!==base.origin||!path.pathname.startsWith('/api/'))return fail(404);
    if(Number(req.headers['content-length'])>65536)return fail(413);
    const headers={'x-clinch-relay':relaySecret};
    for(const name of ['content-type','origin','cookie','authorization','x-csrf-token'])
      if(req.headers[name])headers[name]=req.headers[name];
    const outgoing=request(path,{method:req.method,headers},response=>{
      const fields={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Type':'application/json; charset=utf-8'};
      if(response.headers['set-cookie'])fields['Set-Cookie']=response.headers['set-cookie'];
      res.writeHead(response.statusCode,fields);
      response.on('error',()=>res.destroy());
      response.pipe(res);
    });
    outgoing.on('error',()=>{if(!res.writableEnded)fail(502);});
    outgoing.setTimeout(14000,()=>outgoing.destroy());
    let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>65536){outgoing.destroy();if(!res.writableEnded)fail(413);}});
    req.on('aborted',()=>outgoing.destroy());
    req.pipe(outgoing);
  });
}
