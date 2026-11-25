(() => {
'use strict';
const loopback=['localhost','127.0.0.1','[::1]'].includes(globalThis.location?.hostname);
const localDemo=globalThis.location?.protocol==='file:' || (loopback&&new URLSearchParams(globalThis.location.search).get('demo')==='1');
let csrf = '';
function setSession(session) { csrf = session?.csrf || ''; }
async function api(path, body) {
  if(localDemo)return globalThis.ClinchDemo.request(path,body);
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),15000);
  try {
    const response = await fetch(`/api${path}`, {method:body === undefined ? 'GET':'POST',credentials:'same-origin',headers:{...(body === undefined ? {} : {'Content-Type':'application/json','X-CSRF-Token':csrf})},...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:controller.signal});
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'Something went wrong. Please try again.');error.status=response.status;error.code=data.code;throw error; }
    return data;
  } catch(e) { if(e.name==='AbortError') throw new Error('The hub took too long to respond. Please check your connection.'); if(e instanceof TypeError) throw new Error('The hub is unreachable. Check your connection and try again.');throw e; }
  finally {clearTimeout(timeout);}
}

globalThis.ClinchApi=Object.freeze({api,setSession,localDemo});
})();
